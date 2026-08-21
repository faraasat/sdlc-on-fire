import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App.js';
import './styles.css';

/**
 * Entry (P3-UI-01).
 *
 * Refetch-on-focus is off because the WebSocket already keeps the board
 * current, and leaving both on means every alt-tab refetches data that a
 * change event would have invalidated anyway. Retries are low for the same
 * reason: a failed request will be re-driven by the next change event or the
 * reconnect, so a long retry ladder only delays the error the user needs to see.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
      staleTime: 5_000,
    },
  },
});

const container = document.getElementById('root');
if (container === null) throw new Error('no #root element in index.html');

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
