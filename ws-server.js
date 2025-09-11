#!/usr/bin/env node
// Minimal WebSocket relay for RescueMind (optional)
// Requires: npm i ws
// Usage: node ws-server.js [port]

const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || process.argv[2] || 8080;
const server = http.createServer();
const wss = new WebSocket.Server({ server });

function broadcast(sender, msg) {
  wss.clients.forEach((client) => {
    if (client !== sender && client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

wss.on('connection', (ws) => {
  ws.on('message', (data) => {
    // Basic validation and fanout
    let obj;
    try { obj = JSON.parse(String(data)); } catch { return; }
    if (!obj || typeof obj !== 'object') return;
    // Optionally cap message size
    if (JSON.stringify(obj).length > 4096) return;
    broadcast(ws, JSON.stringify(obj));
  });
});

server.listen(PORT, () => {
  console.log(`WS relay listening on ws://localhost:${PORT}`);
});

