// ============================================================
// 09-ui.js — UI: buildQueue, startGnnGame, addMenuButton,
//            patchScheduler, overlay, GnnEventHooks
// ============================================================
"use strict";

// === Очередь построек ===
window.buildQueue = window.buildQueue || [];

window.scheduleAIBuilding = function (type, x, y, delay = 0) {
  if (typeof canBuild === "function" && !canBuild(type)) return false;
  window.buildQueue.push({
    type, x, y,
    plannedAt: performance.now(),
    delay,
    failCount: 0
  });
  //console.log(`[BUILD DEBUG] 📝 Запланировано: ${type} на (${x.toFixed(0)}, ${y.toFixed(0)})`);
  return true;
};

window.processBuildQueue = function () {
  const now = performance.now();
  for (let i = 0; i < window.buildQueue.length; i++) {
    const item = window.buildQueue[i];
    if (now - item.plannedAt >= item.delay) {
      if (typeof aiPlaceBuilding !== "function") {
        //console.error(`[BUILD DEBUG] ❌ aiPlaceBuilding НЕ НАЙДЕНА!`);
        window.buildQueue.splice(i, 1); i--; continue;
      }
      const built = aiPlaceBuilding(item.type, item.x, item.y);
      if (built) {
        //console.log(`[BUILD DEBUG] 🎉 УСПЕХ! ${item.type} построен на (${item.x}, ${item.y})`);
        window.buildQueue.splice(i, 1); i--;
      } else {
        item.failCount = (item.failCount || 0) + 1;
        if (item.failCount >= 3) {
          //console.error(`[BUILD DEBUG] ❌ СБОЙ: ${item.type} не размещён после 3 попыток. Удаляю.`);
          window.buildQueue.splice(i, 1); i--;
        } else {
          //console.warn(`[BUILD DEBUG] ⚠️ ПРОВАЛ (${item.failCount}/3): повтор через 2с.`);
          item.plannedAt = now + 2000;
        }
      }
    }
  }
};

// === Запуск GNN-игры ===
async function startGnnGame() {
  if (typeof stopAllIntervals === "function") stopAllIntervals();
  if (window.__aiSaleQueueInterval) {
    clearInterval(window.__aiSaleQueueInterval);
    window.__aiSaleQueueInterval = null;
  }

  // Отключаем стандартную логику
  window.processAIMilitaryProductionQueue = function() {};
  window.updateAIProductionQueues = function() {};
  window.attemptToEnqueueMilitaryOrders = function() {};
  window.attemptToHireWorkers = function() {};
  window.attemptToHireRepairman = function() {};
  window.processAISaleQueue = function() {};
  window.aiLogic = function() {};

  await GnnAI.init();

  const elementsToHide = [
    document.getElementById("loadingScreen"),
    document.getElementById("welcomeScreen"),
    document.getElementById("mainMenu"),
    document.querySelector(".overlay"),
    document.querySelector(".menu-screen"),
    document.querySelector(".welcome-screen")
  ];
  elementsToHide.forEach(el => {
    if (el) { el.style.display = "none"; el.style.visibility = "hidden"; }
  });

  const gnnBtn = document.getElementById("gnnButton");
  if (gnnBtn) gnnBtn.style.display = "none";

  gameStarted = true;
  gameMode = "gnn";
  if (typeof window.neuralAIActive !== "undefined") window.neuralAIActive = false;
  isPaused = false;
  playerId = "player";
  opponentId = null;
  gameState.gameEnded = false;

  // Очистка состояния
  gameState.buildings = [];
  gameState.units = [];
  gameState.fragments = [];
  gameState.particles = [];
  gameState.resources = [];
  gameState.bullets = [];
  gameState.lasers = [];
  gameState.capturePoints = [];
  gameState.resourceTokens = [];
  gameState.recentBuilds = [];
  gameState.recentLosses = [];
  gameState.attackers = [];
  gameState.repairmen = [];
  gameState.defenders = [];
  gameState.playerResources = { gold: 100, silicon: 100, plasma: 50 };
  gameState.aiResources = { gold: 100, silicon: 100, plasma: 50 };
  gameState.playerScore = 0;
  selectedUnits = [];

  const m = 300;
  playerBase = new Building("base", "player", m, m);
  aiBase = new Building("base", "ai", worldWidth - m, worldHeight - m);
  playerBase.active = true;
  aiBase.active = true;
  gameState.buildings.push(playerBase, aiBase);

  // Динамическая синхронизация размера мира
  GnnAI.cfg.WORLD_WIDTH = typeof worldWidth !== 'undefined' ? worldWidth : 2000;
  GnnAI.cfg.WORLD_HEIGHT = typeof worldHeight !== 'undefined' ? worldHeight : 2000;

  if (typeof generateResources === "function") generateResources(100);
  if (typeof initFogOfWar === "function") initFogOfWar();

  camera.offsetX = canvas.width / 2 - playerBase.x * camera.scale;
  camera.offsetY = canvas.height / 2 - playerBase.y * camera.scale;

  const controls = document.getElementById("controlsWrapper");
  if (controls) controls.style.display = "block";

  GnnAI.startEpisode("gnn");

  if (window.AIScheduler) AIScheduler.start("gnn");
  else {
    if (GnnAI._fallback) clearInterval(GnnAI._fallback);
    GnnAI._fallback = setInterval(() => {
      tf.tidy(() => { GnnAI.tick(); });
    }, 250);
  }

  if (typeof window.startTrainingBot === "function") window.startTrainingBot();

  lastTime = performance.now();
  requestAnimationFrame(gameLoop);
  console.log("[GnnAI] 🚀 Матч начат (v7.7)");

  setTimeout(() => {
    document.querySelectorAll('div').forEach(div => {
      if (div.style.zIndex >= 100 && div.offsetWidth > window.innerWidth * 0.5) {
        if (!div.id.includes('gnn-training') && div.tagName !== 'CANVAS') {
          div.style.display = 'none';
        }
      }
    });
  }, 300);

  // Фиксируем точку отсчёта L2 для дельты сессии
  try {
    let l2Sum = 0;
    for (const v of GnnAI.vars) {
      const data = v.dataSync();
      for (let i = 0; i < data.length; i++) {
        if (isFinite(data[i])) l2Sum += data[i] * data[i];
      }
    }
    GnnAI.sessionStartL2 = Math.sqrt(l2Sum);
    //console.log(`[GnnAI] 🎬 Старт матча. Точка отсчёта L2: ${GnnAI.sessionStartL2.toFixed(4)}`);
  } catch (e) {
    //.warn("[GnnAI] ⚠️ Не удалось зафиксировать точку отсчёта L2:", e);
    GnnAI.sessionStartL2 = 0;
  }
}

// === Кнопка в меню ===
function addMenuButton() {
  const loading = document.getElementById("loadingScreen");
  if (!loading || document.getElementById("gnnButton")) return;

  const btn = document.createElement("button");
  btn.id = "gnnButton";
  btn.innerText = "Графии v7.7";
  btn.style.cssText = "font-family: 'Orbitron', sans-serif; font-size: 18px; padding: 12px 28px; border: 2px solid #00ff99; color: #00ff99; background: rgba(0,255,120,0.08); border-radius: 50px; box-shadow: 0 0 15px rgba(0,255,120,0.5); cursor: pointer; transition: all 0.3s ease; z-index: 10; margin-top: 10px;";
  btn.onmouseenter = () => { btn.style.background = "rgba(0,255,120,0.2)"; btn.style.transform = "scale(1.05)"; };
  btn.onmouseleave = () => { btn.style.background = "rgba(0,255,120,0.08)"; btn.style.transform = "scale(1)"; };
  btn.onclick = startGnnGame;

  const neural = document.getElementById("neuralButton");
  if (neural && neural.parentNode === loading) neural.insertAdjacentElement("afterend", btn);
  else loading.appendChild(btn);
}

// === Патч планировщика ===
function patchScheduler() {
  if (!window.AIScheduler || AIScheduler.__gnnPatched) return;
  AIScheduler.__gnnPatched = true;
  const origTick = AIScheduler.tick.bind(AIScheduler);
  AIScheduler.tick = function () {
    if (this.mode === "gnn") {
      if (!this.running || typeof gameStarted === "undefined" || !gameStarted) return;
      if (typeof isPaused !== "undefined" && isPaused) return;
      if (typeof gameState === "undefined" || gameState.gameEnded) { this.stop(); return; }
      if (gameMode !== "gnn") { this.stop(); return; }
      tf.tidy(() => { GnnAI.tick(); });
      return;
    }
    return origTick();
  };
}

// === Оверлей обучения ===
function createTrainingOverlay() {
  if (document.getElementById('gnn-training-overlay')) return;
  const overlay = document.createElement('div');
  overlay.id = 'gnn-training-overlay';
  overlay.style.cssText = `position: fixed; top: 10px; right: 10px; background: rgba(0, 0, 0, 0.8); color: #00ff99; font-family: monospace; font-size: 12px; padding: 12px; border-radius: 8px; border: 1px solid #00ff99; z-index: 9999; pointer-events: none;`;
  overlay.innerHTML = `
    <div style="font-weight:bold; margin-bottom:5px; color:#fff;">🧠 GNN AUTO-TRAINING</div>
    <div id="ov-episode">Episode: <span style="color:#fff">-</span></div>
    <div id="ov-winrate">Winrate: <span style="color:#fff">-</span></div>
    <div id="ov-action">Last: <span style="color:#87ceeb">-</span></div>
    <div id="ov-entropy">🎚️ Entropy: <span style="color:#fff">-</span></div>
    <div style="margin-top:5px; border-top:1px solid #00ff99; padding-top:5px;">
      ⚔️ Army: <span id="ov-army" style="color:#ff6b6b">0</span> |
      👷 Workers: <span id="ov-workers" style="color:#ffd93d">0</span>
    </div>
  `;
  document.body.appendChild(overlay);
}

window.updateTrainingOverlay = function() {
  const overlay = document.getElementById('gnn-training-overlay');
  if (!overlay || !window.gameState || !window.GnnAI) return;
  const m = GnnAI.metrics();
  const stats = GnnAI.readStats();
  const gnnStats = stats.filter(s => s.mode === 'gnn');
  const wins = gnnStats.filter(s => s.result === 'win').length;
  const total = gnnStats.length || 1;
  const winrate = ((wins / total) * 100).toFixed(1);
  const workers = gameState.units.filter(u => u.owner === 'ai' && u.type === 'worker' && u.health > 0).length;

  document.getElementById('ov-episode').innerHTML = `Episode: <span style="color:#fff">#${total}</span>`;
  document.getElementById('ov-winrate').innerHTML = `Winrate: <span style="color:${winrate>=50?'#6bcb77':'#ff6b6b'}">${winrate}%</span>`;
  document.getElementById('ov-action').innerHTML = `Last: <span style="color:#87ceeb">${GnnAI.lastAction || 'init'}</span>`;

  const entropyCoef = typeof GnnAI.getEntropyCoef === 'function' ? GnnAI.getEntropyCoef() : 0.05;
  let entropyColor = '#ff6b6b';
  let entropyPhase = '🎯 Exploit';
  if (entropyCoef >= 0.04) {
    entropyColor = '#6bcb77';
    entropyPhase = '🔍 Explore';
  } else if (entropyCoef >= 0.02) {
    entropyColor = '#ffd93d';
    entropyPhase = '🔄 Balance';
  }
  document.getElementById('ov-entropy').innerHTML = `🎚️ Entropy: <span style="color:${entropyColor}">${entropyCoef.toFixed(4)}</span> <span style="color:${entropyColor}; font-size:10px;">${entropyPhase}</span>`;

  document.getElementById('ov-army').innerText = m.aiArmy;
  document.getElementById('ov-workers').innerText = workers;
};

// Патч requestAnimationFrame для обновления оверлея раз в 500мс
const _origRAF = window.requestAnimationFrame;
let lastOverlayUpdate = 0;
const OVERLAY_UPDATE_INTERVAL = 500;

window.requestAnimationFrame = function(callback) {
  return _origRAF(function(ts) {
    if (window.gameStarted && !gameState.gameEnded) {
      if (ts - lastOverlayUpdate > OVERLAY_UPDATE_INTERVAL) {
        window.updateTrainingOverlay();
        lastOverlayUpdate = ts;
      }
    }
    callback(ts);
  });
};

// === Автостарт при загрузке ===
window.addEventListener("load", () => {
  if (typeof addMenuButton === "function") addMenuButton();
  if (typeof patchScheduler === "function") patchScheduler();
  console.log("[GnnAI] ✅ Система загружена и готова.");

  if (localStorage.getItem('gnn_auto_restart') === 'true') {
    console.log("[AutoStart] 🚀 Обнаружен режим авто-обучения.");
    setTimeout(() => {
      console.log("[AutoStart] ⏱ Запуск GNN...");
      window.autoRestartEnabled = true;
      window.aiDifficulty = window.aiDifficulty || 0;
      createTrainingOverlay();
      if (typeof window.startGnnGame === "function") window.startGnnGame();
      else console.error("[AutoStart] ❌ startGnnGame не найдена!");
    }, 1500);
  }
});

// === Флаги визуализации ===
if (typeof window.showGnnGraph === 'undefined') window.showGnnGraph = false;
if (typeof window.showGnnLegend === 'undefined') window.showGnnLegend = false;

// === Экспорт в глобал ===
window.startGnnGame = startGnnGame;

// === СОБЫТИЙНЫЕ ХУКИ ДЛЯ GNN ===
window.GnnEventHooks = {
  onUnitDamaged: function(unit, damage, source) {
    if (!unit || !unit.missionLog) return;
    unit.missionLog.damageTaken += damage;
    unit.missionLog.events.push({
      t: performance.now() - unit.missionLog.startTime,
      type: "damage_taken",
      amount: damage,
      from: source ? { type: source.type, owner: source.owner } : null,
      pos: { x: unit.x, y: unit.y },
      hpAfter: unit.health
    });
    if (source && source.type && source.type.startsWith("turret")) {
      unit.missionLog.hitByTurret = true;
    }
  },

  onUnitDealtDamage: function(unit, damage, target) {
    if (!unit || !unit.missionLog) return;
    if (target && target.id === unit.missionLog.targetId) {
      unit.missionLog.damageDealt += damage;
    }
    unit.missionLog.events.push({
      t: performance.now() - unit.missionLog.startTime,
      type: "damage_dealt",
      amount: damage,
      to: target ? { id: target.id, type: target.type, owner: target.owner } : null,
      isPrimaryTarget: target && target.id === unit.missionLog.targetId
    });
  },

  onUnitDeath: function(unit, killer) {
    if (!unit || !unit.missionLog) return;
    unit.missionLog.alive = false;
    unit.missionLog.deathPos = { x: unit.x, y: unit.y };
    unit.missionLog.killedBy = killer ? { type: killer.type, owner: killer.owner } : null;
    unit.missionLog.events.push({
      t: performance.now() - unit.missionLog.startTime,
      type: "death",
      pos: unit.missionLog.deathPos,
      killedBy: unit.missionLog.killedBy,
      hpAtDeath: 0
    });
  },

  onUnitReachedTarget: function(unit, target) {
    if (!unit || !unit.missionLog) return;
    if (target && target.id === unit.missionLog.targetId) {
      unit.missionLog.reachedTarget = true;
      unit.missionLog.events.push({
        t: performance.now() - unit.missionLog.startTime,
        type: "reached_target",
        targetPos: { x: target.x, y: target.y },
        targetHP: target.health
      });
    }
  },

  onTargetDestroyed: function(unit, target) {
    if (!unit || !unit.missionLog) return;
    if (target && target.id === unit.missionLog.targetId) {
      unit.missionLog.completedMission = true;
      unit.missionLog.events.push({
        t: performance.now() - unit.missionLog.startTime,
        type: "target_destroyed",
        targetPos: { x: target.x, y: target.y }
      });
    }
  }
};

console.log("[GnnAI] 🎨 UI-модуль загружен.");