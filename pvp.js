let socket = null;
let playerId = null;
let playerTeam = null;
let opponentId = null;
let pvpStartedAt = 0;


// 👇 ВНЕ saveModelToServer — отдельная функция!
function connectToPvpServer() {
  gameMode = "pvp";
  socket = new WebSocket("ws://92.63.179.215:8080/ws");

  socket.onopen = () => {
    console.log("[PvP] Соединение установлено");
    showWaitingScreen("🔄 Ожидание второго игрока...");
  };

  socket.onmessage = async (event) => {
    try {
      const text = typeof event.data === "string"
        ? event.data
        : await event.data.text();

      const msg = JSON.parse(text);
      handlePvpMessage(msg);
    } catch (err) {
      console.error("[PvP] Ошибка при обработке сообщения:", err);
      console.error("Сырой ответ:", event.data);
    }
  };
}

function handlePvpMessage(msg) {
	if (msg.type === "chat") {
    displayChatMessage(msg);
  }
  switch (msg.type) {
    case "assignPlayer":
  playerId = msg.playerId;
  playerTeam = (playerId === "player1" || playerId === "player3") ? 1 : 2;
  opponentId = (playerId === "player1") ? "player2" : "player1";
  gameMode = "pvp";
  console.log("[PvP] Назначен как", playerId);

  hideWaitingScreen();
  startPvpGame(msg.initialState || {});
  break;


    case "action":
      if (msg.playerId !== playerId) {
        applyRemoteAction(msg.action);
      }
      break;

    case "end":
      showVictoryScreen(msg.winner === playerId ? "🎉 Ты победил!" : "💀 Ты проиграл...");
      break;

    default:
      console.warn("[PvP] Неизвестный тип сообщения:", msg);
  }
}

function showWaitingScreen(text) {
  const el = document.createElement("div");
  el.id = "waitingScreen";
  el.innerText = text;
  el.style.position = "fixed";
  el.style.top = "50%";
  el.style.left = "50%";
  el.style.transform = "translate(-50%, -50%)";
  el.style.padding = "20px";
  el.style.background = "rgba(0,0,0,0.8)";
  el.style.color = "white";
  el.style.fontSize = "20px";
  el.style.borderRadius = "10px";
  el.style.zIndex = 9999;
  document.body.appendChild(el);
}

function hideWaitingScreen() {
  const el = document.getElementById("waitingScreen");
  if (el) el.remove();
}
function startPvpGame(initialState) {
  pvpStartedAt = performance.now();

  console.log("[PvP] Старт игры");
  resizeCanvas(); // важно!

  gameStarted = true;
  lastTime = performance.now();

  gameState.buildings = [];
  gameState.units = [];
  gameState.fragments = [];
  gameState.particles = [];
  gameState.capturePoints = [];
  gameState.resources = [];

  if (playerId === "player1") {
    const seed = Math.floor(Math.random() * 100000); 
    sendPvpAction({ type: "seed", seed });
    generateResources(seed);
  }

  gameState.playerResources = {
    gold: 100,
    silicon: 100,
    plasma: 50
  };

  gameState.aiResources = {
    gold: 100,
    silicon: 100,
    plasma: 50
  };

  gameState.playerScore = 0;

  const margin = 300;
  const player1Pos = { x: margin, y: margin };
  const player2Pos = { x: worldWidth - margin, y: worldHeight - margin };

  // 📍 Создаём базу игрока 1
  const base1 = new Building("base", "player1", player1Pos.x, player1Pos.y);
  base1.active = true;
  gameState.buildings.push(base1);

  // 📍 Создаём базу игрока 2
  const base2 = new Building("base", "player2", player2Pos.x, player2Pos.y);
  base2.active = true;
  gameState.buildings.push(base2);

  // 📍 Определяем, кто чей
  if (playerId === "player1") {
    playerBase = base1;
    aiBase = base2;
  } else if (playerId === "player2") {
    playerBase = base2;
    aiBase = base1;
  }

  // 📍 Центрируем камеру на своей базе
  camera.offsetX = canvas.width / 2 - playerBase.x * camera.scale;
  camera.offsetY = canvas.height / 2 - playerBase.y * camera.scale;

  document.getElementById("controlsWrapper").style.display = "block";
  
  updateColorSet();
  requestAnimationFrame(gameLoop);
}


function sendPvpAction(action) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "action", playerId, action }));
  }
}
function generateUniqueUnitId() {
  return "unit_" + Math.random().toString(36).substr(2, 9);
}


function applyRemoteAction(action) {
	if (gameMode === "single") return;

  switch (action.type) {
		  
		  

		  case "seed": {
  generateResources(action.seed); // 💥 генерация ресурсов по сиду
  break;
}


    case "buildingDie": {
      const building = gameState.buildings.find(b => b.id === action.buildingId);
      if (building) {
        triggerSale(building);
      }
      break;
    }

    case "shockPerk": {
      shockZones.push({
        x: action.x,
        y: action.y,
        start: performance.now(),
        radius: 0,
        lightningBolts: []
      });
      break;
    }

    case "bombPerk": {
      bombZones.push({
        x: action.x,
        y: action.y,
        start: performance.now(),
        exploded: false,
        radius: 0
      });
      break;
    }

    case "formation": {
      const unit = gameState.units.find(u => u.id === action.unitId);
      if (unit) {
        unit.commandQueue = [{ type: "move", x: action.x, y: action.y }];
        applyFormationBuff([unit], action.formationType);
        processCommandQueue(unit);
      }
      break;
    }

    case "build": {
      const b = new Building(action.buildingType, action.owner, action.x, action.y);
      b.id = action.id || generateUniqueBuildingId();
      b.builtAt = performance.now();
      b.active = true;
      gameState.buildings.push(b);

      if (["turret", "turret2", "turret3"].includes(b.type)) {
        startTurretCycle(b);
      }

      break;
    }

    case "turretFire": {
      const turret = gameState.buildings.find(b => b.id === action.turretId);
      const target = [...gameState.units, ...gameState.buildings].find(t => t.id === action.targetId);
      if (turret && target) {
        if (action.turretType === "turret3") {
          fireLaserShot(turret, target);
        } else {
          fireBullet(turret, target);
        }
      }
      break;
    }

    case "hire": {
  if (!["player1", "player2"].includes(action.playerId)) {
    console.warn("[PvP] ⚠️ Неверный playerId в hire:", action.playerId);
    return;
  }

  const unit = getUnitFromPool(action.unitType, action.playerId, action.x, action.y);
  unit.id = action.unitId || generateUniqueUnitId();
  addUnit(unit); // ✅ вместо gameState.units.push

  if (["fighter", "assault", "elite"].includes(action.unitType)) {
    if (action.unitType === "fighter") startFighterCycle(unit);
    else startAssaultEliteCycle(unit);
  } else if (action.unitType === "worker") {
    const warehouse = gameState.buildings.find(b => b.id === action.warehouseId);
    unit.homeWarehouse = warehouse;
    if (warehouse) warehouse.workers++;
    startWorkerCycle(unit, warehouse);
  } else if (action.unitType === "repairman") {
    const workshop = gameState.buildings.find(b => b.id === action.workshopId);
    unit.homeWorkshop = workshop;
    if (workshop) workshop.repairman++;
    startRepairmanCycle(unit);
  }
  break;
}


    case "move": {
      const mover = gameState.units.find(u => u.id === action.unitId);
      if (mover) {
        mover.commandQueue = [{ type: "move", x: action.x, y: action.y }];
      }
      break;
    }

    case "die": {
  const unit = gameState.units.find(u => u.id === action.unitId);
  if (unit) {
    // 💥 Останавливаем ВСЕ действия юнита немедленно
    if (unit.currentMovementAnimation) {
      cancelAnimationFrame(unit.currentMovementAnimation);
      unit.currentMovementAnimation = null;
    }
    unit.commandQueue = [];
    unit.target = null;

    // 💥 Очищаем все таймеры стрельбы (если есть)
    if (unit.fireTimer) {
      clearTimeout(unit.fireTimer);
      unit.fireTimer = null;
    }
    if (unit.shootingInterval) {
      clearInterval(unit.shootingInterval);
      unit.shootingInterval = null;
    }

    unit.health = 0;

    spawnDestructionFragments(unit.x, unit.y, unit.width || 10, unit.height || 10, unit.type);

    // 💥 Убираем из списков целей
    gameState.units.forEach(u => {
      if (u.target === unit) {
        u.target = null;
        if (u.commandQueue) {
          u.commandQueue = u.commandQueue.filter(cmd => !(cmd.type === "attack" && cmd.target === unit));
        }
      }
    });

    // 💥 Удаляем через 300 мс (чтобы фрагменты успели красиво разлететься)
    setTimeout(() => {
      removeUnit(unit);
    }, 300);
  }
  break;
}




    case "defend": {
      const unit = gameState.units.find(u => u.id === action.unitId);
      if (unit) {
        unit.commandQueue = [{ type: "move", x: action.x, y: action.y }];
        unit.defending = true;
        processCommandQueue(unit);
      }
      break;
    }

    case "scout": {
      const unit = gameState.units.find(u => u.id === action.unitId);
      if (unit) {
        unit.commandQueue = [{ type: "move", x: action.x, y: action.y }];
        unit.scouting = true;
        processCommandQueue(unit);
      }
      break;
    }

    case "attack": {
      const attacker = gameState.units.find(u => u.id === action.unitId);
      const target = [...gameState.units, ...gameState.buildings].find(t => t.id === action.targetId);
      if (attacker && target) {
        attacker.commandQueue = [
          { type: "move", x: action.x, y: action.y },
          { type: "attack", target }
        ];
        attacker.target = target;
        processCommandQueue(attacker);
      }
      break;
    }

    default:
      console.warn("[PvP] Неизвестное действие:", action);
  }
}

function startPvpDirectly() {
  const loadingScreen = document.getElementById("loadingScreen");
  if (loadingScreen) loadingScreen.style.display = "none";

  connectToPvpServer();
}



const chatInput = document.getElementById("chat-input");
const chatSend = document.getElementById("chat-send");
const chatMessages = document.getElementById("chat-messages");
const chatChannel = document.getElementById("chat-channel");
const chatToggleBtn = document.getElementById("chat-toggle");
let chatVisible = true;

chatToggleBtn.addEventListener("click", () => {
  chatVisible = !chatVisible;
  chatMessages.style.display = chatVisible ? "flex" : "none";
  chatToggleBtn.textContent = chatVisible ? "🡇 Скрыть чат" : "🡅 Показать чат";
});


chatSend.addEventListener("click", sendChatMessage);
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendChatMessage();
});

function sendChatMessage() {
  const text = chatInput.value.trim();
  if (!text) return;
  const channel = chatChannel.value;

  const msg = {
    type: "chat",
    channel,
    text
  };

  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(msg));
  }

  // 🔽 Отображаем локально, чтобы сразу видеть сообщение
  displayChatMessage({
    channel,
    text,
    name: "Вы",         // можно заменить на локальное имя игрока
    ownerId: playerId,  // чтобы стилизовать как своё
    team: playerTeam    // если хочешь цвет или иконку
  });

  chatInput.value = "";
}


function displayChatMessage(data) {
  const prefix = data.channel === "team" ? "[Команда]" : "[Общий]";
  const name = data.name === "Вы" ? "Вы" : data.name;
  const text = `${prefix} ${name}: ${data.text}`;

  // 📌 Добавляем в историю (не исчезает)
  const historyEntry = document.createElement("div");
  historyEntry.classList.add("chat-line");
  historyEntry.textContent = text;
  chatMessages.appendChild(historyEntry);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  // 📌 Добавляем всплывающее сообщение (исчезает)
  const floatEntry = document.createElement("div");
  floatEntry.classList.add("chat-float-entry");
  floatEntry.textContent = text;
  document.getElementById("chat-float").appendChild(floatEntry);

  // ⏳ Удалить всплывающее через 5 сек
  setTimeout(() => {
    floatEntry.classList.add("fade-out");
    setTimeout(() => {
      if (floatEntry.parentElement) floatEntry.remove();
    }, 1000);
  }, 5000);
}




