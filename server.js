// === WebSocket сервер (порт 8080) ===
const WebSocket = require("ws");
const path = require("path");

const wss = new WebSocket.Server({ port: 8080 });
let players = [];

wss.on("connection", (ws) => {
  console.log("🔌 Новый клиент подключился");

  const id = "player" + (players.length + 1);
  const team = (players.length % 2) + 1;
  const name = "Игрок " + (players.length + 1);

  ws.meta = { id, team, name };
  players.push(ws);

  const initialState = generateInitialState();
  ws.send(JSON.stringify({ type: "assignPlayer", playerId: id, initialState }));

  console.log(`🧍 ${id} (${name}) присоединился, команда ${team}`);

  ws.on("message", (data) => handleMessage(ws, data));

  ws.on("close", () => {
    console.log(`❌ ${id} отключился`);
    players = players.filter(p => p !== ws);
    players.forEach(p => {
      if (p.readyState === WebSocket.OPEN) {
        p.send(JSON.stringify({ type: "playerDisconnected", playerId: id }));
      }
    });
  });
});

function handleMessage(sender, raw) {
  try {
    const msg = JSON.parse(raw);

    if (msg.type === "chat") {
      const enriched = {
        type: "chat",
        channel: msg.channel,
        text: msg.text,
        name: sender.meta.name,
        ownerId: sender.meta.id,
        team: sender.meta.team
      };

      if (msg.channel === "global") {
        broadcast(enriched);
      } else if (msg.channel === "team") {
        players.forEach(p => {
          if (p.meta.team === sender.meta.team && p.readyState === WebSocket.OPEN) {
            p.send(JSON.stringify(enriched));
          }
        });
      }
    } else {
      // Все прочие сообщения — пересылаем другим игрокам
      players.forEach(p => {
        if (p !== sender && p.readyState === WebSocket.OPEN) {
          p.send(raw);
        }
      });
    }
  } catch (e) {
    console.error("❌ Ошибка при обработке сообщения:", e);
  }
}

function broadcast(msgObj) {
  const text = JSON.stringify(msgObj);
  players.forEach(p => {
    if (p.readyState === WebSocket.OPEN) {
      p.send(text);
    }
  });
}

// Начальное состояние — можно расширять по нужде
function generateInitialState() {
  return {
    buildings: [
      { id: "base1", type: "base", owner: "player1", x: 300, y: 300 },
      { id: "base2", type: "base", owner: "player2", x: 1200, y: 800 },
      { id: "base3", type: "base", owner: "player3", x: 300, y: 800 },
      { id: "base4", type: "base", owner: "player4", x: 1200, y: 300 }
    ],
    units: [],
    resources: [],
    playerResources: { gold: 230, silicon: 270, plasma: 130 },
    aiResources: { gold: 230, silicon: 270, plasma: 130 },
    playerScore: 0,
    attackers: [],
    repairmen: [],
    defenders: []
  };
}

console.log("🛰️ WebSocket PvP сервер на ws://92.63.179.215:8080");
