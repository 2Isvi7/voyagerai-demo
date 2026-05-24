// Event bus + SSE registry. Two streams:
//   - per-chat: tied to a chat session id, carries chunks/tool calls/control flow for one Assistant conversation.
//   - global MCP timeline: every agent action across all sessions, used by the MCP Server "Event Timeline" panel.

const sessionClients = {};   // { sessionId: [res, ...] }
const timelineClients = [];  // [res, ...]
const bookingClients = {};   // { bookingId: [res, ...] }

function writeSSE(res, data) {
  try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch (_) {}
}

function registerSession(sessionId, res) {
  sessionClients[sessionId] = sessionClients[sessionId] || [];
  sessionClients[sessionId].push(res);
}

function dropSession(sessionId, res) {
  if (!sessionClients[sessionId]) return;
  sessionClients[sessionId] = sessionClients[sessionId].filter((r) => r !== res);
  if (sessionClients[sessionId].length === 0) delete sessionClients[sessionId];
}

function pushSession(sessionId, data) {
  (sessionClients[sessionId] || []).forEach((res) => writeSSE(res, data));
}

function registerTimeline(res) {
  timelineClients.push(res);
}

function dropTimeline(res) {
  const i = timelineClients.indexOf(res);
  if (i !== -1) timelineClients.splice(i, 1);
}

// Pushes to the global MCP Event Timeline. Shape mirrors what the video shows:
// { ts, kind, label, http?, decision?, body, agent }
function emitTimeline(evt) {
  const enriched = { ts: new Date().toISOString(), ...evt };
  timelineClients.forEach((res) => writeSSE(res, enriched));
  return enriched;
}

// Booking-status channel (one per Tier 3 booking)
function registerBooking(bookingId, res) {
  bookingClients[bookingId] = bookingClients[bookingId] || [];
  bookingClients[bookingId].push(res);
}

function dropBooking(bookingId, res) {
  if (!bookingClients[bookingId]) return;
  bookingClients[bookingId] = bookingClients[bookingId].filter((r) => r !== res);
  if (bookingClients[bookingId].length === 0) delete bookingClients[bookingId];
}

function pushBooking(bookingId, data) {
  (bookingClients[bookingId] || []).forEach((res) => writeSSE(res, data));
}

module.exports = {
  registerSession,
  dropSession,
  pushSession,
  registerTimeline,
  dropTimeline,
  emitTimeline,
  registerBooking,
  dropBooking,
  pushBooking,
};
