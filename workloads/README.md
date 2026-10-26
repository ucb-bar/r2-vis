# Workloads

The regression workloads of r2-vis as Neutrino kernels: Rust crates with
`#[nu_program]` functions, one image per program, each with its source map.
A crate builds beside an r2-toolchain checkout (its `nu-abi` and `nu-soc`
are path dependencies, `../../../r2-toolchain`): set up the toolchain
as r2-toolchain's README describes, then run `r2-build --config
<r2-sim>/configs/<config>.yaml` in the crate's directory. The images and
`srcmap.json` go to `out/`, which git ignores.

Without network access, cargo cannot fetch the dependencies of `nu-abi` from
crates.io: copy the `Cargo.lock` of an r2-toolchain example (with the package
name changed) and build with `CARGO_NET_OFFLINE=true`, so that cargo uses the
local registry cache.
