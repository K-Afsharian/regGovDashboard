// main.tsx — Entry point for the React app.
// React finds the <div id="root"> in index.html and mounts the entire app inside it.
// StrictMode is a development helper that warns you about potential bugs (no effect in production).

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
