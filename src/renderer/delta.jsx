import React from 'react';
import { createRoot } from 'react-dom/client';
import { DeltaBar } from './components/DeltaBar.jsx';
import './styles/global.css';

const root = createRoot(document.getElementById('root'));
root.render(<DeltaBar />);
