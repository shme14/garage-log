import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import { bootSync } from './sync/boot'
import './ui/styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// Once per app session, outside React so StrictMode cannot run it twice.
void bootSync()
