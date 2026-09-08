import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { DialogStackProvider } from './Dialog';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DialogStackProvider>
      <App />
    </DialogStackProvider>
  </StrictMode>,
);
