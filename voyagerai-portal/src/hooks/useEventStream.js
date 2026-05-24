import { useEffect, useRef, useState } from 'react';

// Subscribe to a Server-Sent Events endpoint. Returns the most recent event +
// a cumulative log (capped). Reconnects automatically.
//
// Usage:
//   const { last, events, connected } = useEventStream('/api/mcp/events');

export function useEventStream(url, { enabled = true, max = 200 } = {}) {
  const [last, setLast] = useState(null);
  const [events, setEvents] = useState([]);
  const [connected, setConnected] = useState(false);
  const esRef = useRef(null);

  useEffect(() => {
    if (!enabled || !url) return undefined;
    const es = new EventSource(url, { withCredentials: false });
    esRef.current = es;

    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (msg) => {
      try {
        const parsed = JSON.parse(msg.data);
        setLast(parsed);
        setEvents((prev) => {
          const next = [parsed, ...prev];
          return next.length > max ? next.slice(0, max) : next;
        });
      } catch (_) { /* heartbeat or non-JSON */ }
    };

    return () => { es.close(); esRef.current = null; setConnected(false); };
  }, [url, enabled, max]);

  const reset = () => setEvents([]);
  return { last, events, connected, reset };
}
