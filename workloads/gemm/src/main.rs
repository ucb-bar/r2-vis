//! gemm: r2-sim's `--program kernels` with its GEMM listing (one
//! CUTLASS 2.x multistage GEMM, C = A B, on one SM of rtx6000) as RV64
//! images. A is 128 x 64, B is 64 x 128, C is 128 x 128, all bf16 in the
//! GDDR7. One CTA computes the whole C tile on root.gpc0.sm0: per k-tile of
//! 32, DMAs of the A and B tiles into an SMEM stage buffer, then four warps
//! each multiply their 64 x 64 part of C on their own Atlas; C then goes
//! back to the GDDR7.
//!
//! As in r2-sim, the device starts a program on the cluster, the cluster one
//! on the SM, and each waits for its child.
//!
//! Build: `r2-build --config <r2-sim>/configs/rtx6000.yaml` in this directory.
#![no_std]
#![no_main]

use nu_abi::{desc, insn, nu_program};
use nu_soc::{dst, gpc, key, root, sm, GRANULE_SHIFT};

/// The granule of the configuration: the unit of ranges and masks.
const GRANULE: u64 = 1 << GRANULE_SHIFT;
/// Bytes of a bf16 element.
const ELEM: u64 = 2;

// The problem and its tiling (gemm.toml).
const M: u64 = 128;
const N: u64 = 128;
const K: u64 = 64;
/// The CTA's block of C, and the k-tile.
const BM: u64 = 128;
const BN: u64 = 128;
const BK: u64 = 32;
/// SMEM stage buffers for the A and B tiles (k-tile kt uses kt mod STAGES).
const STAGES: u64 = 2;
const K_TILES: u64 = K / BK;

// The warps (CUTLASS sm80): 64 x 64 warp tiles, two by two over the block.
const WARPS: u64 = 4;
const WARPS_M: u64 = 2;
const WARP_ROWS: u64 = BM / WARPS_M;
const WARP_COLS: u64 = BN / (WARPS / WARPS_M);
/// The Atlas of each warp (warp w on unit w).
const ATLAS: [u16; WARPS as usize] = [sm::PE_ATLAS0, sm::PE_ATLAS1, sm::PE_ATLAS2, sm::PE_ATLAS3];

// Sizes in bytes.
const A_TILE: u64 = BM * BK * ELEM;
const B_TILE: u64 = BK * BN * ELEM;
const C_BYTES: u64 = BM * BN * ELEM;
const C_ROW: u64 = BN * ELEM;
/// A warp's part of C: WARP_ROWS rows of WARP_COLS elements, one C row
/// apart. As a range it spans from its first byte to its last; the mask
/// selects its granules (Neutrino spec, the warp-tile example): granule i
/// of the span is in row i / (C_ROW / GRANULE), and the mask lets the row
/// bits vary, so each row's first WARP_COLS * ELEM bytes are the part's.
const PART_SPAN: u64 = (WARP_ROWS - 1) * C_ROW + WARP_COLS * ELEM;
const PART_MASK: u32 = ((WARP_ROWS - 1) * (C_ROW / GRANULE)) as u32;

/// r2-sim's kernels program places the tensors one after another on 4 KiB
/// boundaries at the base of the GDDR7.
const TENSOR_ALIGN: u64 = 4096;
const A_AT: u64 = 0;
const B_AT: u64 = A_AT + (M * K * ELEM).next_multiple_of(TENSOR_ALIGN);
const C_AT: u64 = B_AT + (K * N * ELEM).next_multiple_of(TENSOR_ALIGN);

/// The sync-only records of a parent (as r2-sim's kernels program): the
/// child's IMEM copy, then its done.
const RECORD: u64 = 512;

/// The programs take no arguments: gemm.toml fixes the problem.
pub struct Args;

/// The CTA on this SM: the k-tiles' loads and warp matmuls, then the store of C.
#[nu_program(node = sm, stack = 2048)]
fn gemm_cta(_: &Args) {
    // region: The SMEM of this SM: the stage buffers, then the C tile
    let smem = insn::prefix() | sm::SMEM;
    let stage = |s: u64| smem + s * (A_TILE + B_TILE);
    let c = smem + STAGES * (A_TILE + B_TILE);
    // Warp w's part of C: rows (w mod WARPS_M) x WARP_ROWS, columns
    // (w / WARPS_M) x WARP_COLS.
    let part = |w: u64| c + (w % WARPS_M) * WARP_ROWS * C_ROW + (w / WARPS_M) * WARP_COLS * ELEM;
    // The GDDR7 through the linear range of the hash link, which spreads the
    // lines over the 64 channels (root::HBM is the channels' physical range).
    let gddr = root::prefix() | root::HBM_LINEAR;
    // endregion
    for kt in 0..K_TILES {
        // region: Load the k-tile's A and B tiles into its stage buffer
        // A tile kt is A[0..BM, kt BK..(kt + 1) BK], B tile kt is
        // B[kt BK..(kt + 1) BK, 0..BN]; each is contiguous in the GDDR7.
        let (a, b) = (stage(kt % STAGES), stage(kt % STAGES) + A_TILE);
        let load_a = desc::dma(sm::PE_DMA, dst(a, A_TILE), gddr + A_AT + kt * A_TILE, a, A_TILE);
        unsafe { insn::invoke(load_a.addr()) };
        let load_b = desc::dma(sm::PE_DMA, dst(b, B_TILE), gddr + B_AT + kt * B_TILE, b, B_TILE);
        unsafe { insn::invoke(load_b.addr()) };
        // endregion
        // region: Each warp multiplies its part of C on its own Atlas
        // A buffer holds version kt / STAGES + 1 of its range; a warp's part
        // of C has version kt after k-tile kt - 1.
        let tile = kt / STAGES + 1;
        for w in 0..WARPS {
            let mut mm = desc::matmul(
                ATLAS[w as usize],
                dst(part(w), PART_SPAN).masked(PART_MASK),
                a + (w % WARPS_M) * WARP_ROWS * BK * ELEM,
                b + (w / WARPS_M) * WARP_COLS * ELEM,
                WARP_ROWS as u32,
                WARP_COLS as u32,
                BK as u32,
                desc::DT_BF16,
            )
            .chain(kt > 0, kt + 1 < K_TILES);
            // B and C rows are a whole block row long.
            mm.args.ldb = BN as u32;
            mm.args.ldc = BN as u32;
            if kt == 0 {
                let mm = mm.with_deps([key(a, tile), key(b, tile)]);
                unsafe { insn::invoke(mm.addr()) };
            } else {
                let mm = mm.with_deps([key(a, tile), key(b, tile), key(part(w), kt)]);
                unsafe { insn::invoke(mm.addr()) };
            }
        }
        // endregion
    }
    // region: Copy C to the GDDR7 once every warp is done, and wait for it
    // A node writes another node's memory only through a pull by the owner's
    // engine (Neutrino spec Section 3): the device's DMA engine copies C, and
    // this invoke goes to the device's Neutrino. (r2-sim's kernels program
    // used the SM's own engine with a record in the SM's sync space as the
    // range; an RV program's descriptor must name the memory it writes.)
    let out = gddr + C_AT;
    let done = core::array::from_fn::<u64, { WARPS as usize }, _>(|w| key(part(w as u64), K_TILES));
    let store = desc::dma(root::PE_DMA, dst(out, C_BYTES), c, out, C_BYTES).with_deps(done);
    unsafe { insn::invoke(store.addr()) };
    insn::wait(key(out, 1));
    // endregion
}

/// Starts the CTA on sm0 of this cluster and waits for it.
#[nu_program(node = gpc, stack = 2048)]
fn gemm_gpc(_: &Args) {
    // region: Start gemm_cta on sm0 and wait for it
    let sync = insn::prefix() | gpc::SYNC;
    let (copy, done) = (dst(sync, RECORD), dst(sync + RECORD, RECORD));
    insn::spawn(0, &gemm_cta, &Args, copy, done);
    insn::wait(key(sync + RECORD, 0));
    // endregion
}

/// The device: starts the kernel's cluster program on gpc0 and waits for it.
#[nu_program(node = root, stack = 2048)]
fn gemm(_: &Args) {
    // region: Start gemm_gpc on gpc0 and wait for it
    let sync = root::prefix() | root::SYNC;
    let (copy, done) = (dst(sync, RECORD), dst(sync + RECORD, RECORD));
    insn::spawn(0, &gemm_gpc, &Args, copy, done);
    insn::wait(key(sync + RECORD, 0));
    // endregion
}
