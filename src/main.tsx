import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import { startApp } from './sync/boot'
import './ui/styles.css'

// startApp finishes a Google sign-in redirect (token out of the URL) before rendering, then boots sync.
void startApp(() =>
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  ),
)
