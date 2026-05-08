// =============================================================================
// rokibrain.app — quickbar renderer entry (M11)
// =============================================================================

import { createRoot } from 'react-dom/client';
import { Quickbar } from './Quickbar';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('quickbar: #root not found');

createRoot(rootEl).render(<Quickbar />);
