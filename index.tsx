import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

// We removed the "import './index.css'" line because the file doesn't exist.
// Tailwind is loaded via the CDN in index.html, so we are good.

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
