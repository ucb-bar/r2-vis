import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './theme/tokens.css'
import './app.css'
import { App } from './App'
import { applyThemeMode, loadThemeMode } from './theme/mode'

applyThemeMode(loadThemeMode(), false)

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
