(function () {
  "use strict";
  if (window.GnnAI) {
    console.warn("[GnnAI] уже загружен");
    return;
  }

  class RingBuffer {
    constructor(capacity) {
      this.capacity = capacity;
      this.buffer = new Array(capacity);
      this.head = 0;
      this.size = 0;
    }
    push(item) {
      this.buffer[this.head] = item;
      this.head = (this.head + 1) % this.capacity;
      if (this.size < this.capacity) this.size++;
    }
    get length() { return this.size; }
    getRandom() {
      if (this.size === 0) return null;
      const idx = Math.floor(Math.random() * this.size);
      return this.buffer[(this.head - this.size + idx + this.capacity) % this.capacity];
    }
  }

  const AIDX = Object.fromEntries(G_ACTIONS.map((a, i) => [a, i]));
  const THREAT_ASSESSMENT = {
    turret: 3, turret2: 5, turret3: 7,
    fighter: 2, assault: 4, elite: 6
  };


  
  const GnnAI = {
    lastReconDiscoveryCheck: 0,
    lastTechStagnationCheck: 0,   // 🔥 отдельный таймер для checkTechStagnation
    lastReplayEntry: null,        // 🔥 ссылка на запись последнего РЕАЛЬНОГО действия
    _pendingShaped: 0,            // 🔥 награды, накопленные до первого действия
    cfg: CFG,
    actions: G_ACTIONS,
    model: null,
    optimizer: null,
    vars: [],
    replay: new RingBuffer(CFG.REPLAY_SIZE),
    pending: [],
    initialized: false,
    training: false,
    trainBatches: 0,
    lastTick: {},
    lastState: null,
    lastAction: null,
    episode: null,
    episodeReport: null,
    lastPhaseCheck: 0,
    strategicMemory: {
      enemyComposition: {},
      threatLevel: 0,
      lastTechLevel: 1,
      techProgressionTime: 0
    },
    missionCache: [],

    // 🔥 СТРАТЕГИЧЕСКАЯ ПАМЯТЬ: кэш разведанных узлов
reconMemory: new Map(), // key: "type_x_y", value: {obj, type, owner, x, y, hp, lastSeen, isStale}
MAX_MEMORY_AGE: 60000,  // 🔥 Базовый TTL: 60 секунд (для зданий и турелей будет больше)

    lastStagnationCheck: 0,
    lastBuildingBuilt: {},
    lastArmySize: 0,
    lastBuildingCount: 0,
    lastResourceTotal: 0,
    lastEcoEffCheck: 0,
    lastResourceControlCheck: 0,
    _lastOutpostCount: 0,
    lastTechLevel: 1,
    lastReconCheck: 0,
    lastArmyActivityCheck: 0,
    lastCombatEfficiencyCheck: 0,
    lastTargetSelectionCheck: 0,
    _lastAttackTargets: [],
    _lastKillCount: 0,
    _lastDeathCount: 0,
    _lastDamageDealt: 0,
    _lastDamageTaken: 0,
    _lastCombatCheckTime: 0,
    _lastArmyPositions: null,
    lastExpansionCheck: 0,
    lastStrategicChangeTime: 0,
    lastStrategicAction: null,
    bcActive: true,
    showWeightStats: false, // Переключатель для отрисовки
    sessionStartL2: 0,
    lastWeightSnapshot: null, // "Тень" прошлых весов
    currentWeightStats: null, // Текущая статистика
    lastStatsUpdate: 0,       // Чтобы не считать каждый кадр (оптимизация)
    bcBatchCount: 0,
    db: null,

PREREQUISITES: {
   "turret": "barracks",       // ← ДОБАВИТЬ
   "turret2": "barracks2", 
   "turret3": "barracks3",
   "barracks2": "base2", 
   "barracks3": "base3",
   "base2": "barracks", 
   "base3": "barracks2"
},
    BUILD_BONUSES: {
      "barracks": 25.0,"base2": 150.0,"barracks2": 60.0,
      "base3": 200.0,"barracks3": 80.0
    },
    BUILD_TIER_GOALS: {
      "barracks":"barracks","base2":"base2","base3":"base3"
    },
    // CURRICULUM LEARNING STATE
    curriculumTier: 0,
    episodesInCurrentTier: 0,
    TIER_THRESHOLD: 3,
    tierGoalsMet: { barracks: false, base2: false, base3: false },

 getGlobalFeatures: function () {
    if (!window.gameState || !window.aiBase) return new Array(CFG.GLOBAL_FEATURES).fill(0);
    
    const m = this.metrics();
    const threat = Math.min(1, this.strategicMemory.threatLevel / 30);
    const baseHp = m.baseHp;
    const enemyNear = Math.min(1, m.enemyNear / 10);
    const myArmy = Math.min(1, m.aiArmy / 20);
    const enemyArmy = Math.min(1, m.enemyArmy / 20);
    const armyBalance = Math.min(1, m.aiArmy / (m.enemyArmy + 1));
    let tech = 1;
    if (gameState.buildings.some(b => b.owner === "ai" && ["base2","barracks2","turret2"].includes(b.type))) tech = 2;
    if (gameState.buildings.some(b => b.owner === "ai" && ["base3","barracks3","turret3"].includes(b.type))) tech = 3;
    const techLevel = tech / 3;
    const resTotal = Math.min(1, (m.res.gold + m.res.silicon + m.res.plasma) / 500);
    const warehouseCount = Math.min(1, m.aiWarehouses / 10);
    const turretCount = Math.min(1, m.aiTurrets / 10);
    const timeNorm = Math.min(1, performance.now() / 600000);    
    const enemyTurrets = Math.min(1, gameState.buildings.filter(b => b.owner === "player" && b.type?.startsWith("turret")).length / 10);
    const enemyElites = Math.min(1, (this.strategicMemory.enemyComposition.elite || 0) / 5);   
    const buildingDiversity = Math.min(1, m.aiBuildings / 15);
    const resourceEfficiency = m.resTotal > 0 ? Math.min(1, m.aiArmy / (m.resTotal / 100)) : 0;
    const expansionProgress = Math.min(1, m.aiWarehouses / 5);
    const defenseStrength = Math.min(1, m.aiTurrets / 5);
    const gameTimeMinutes = performance.now() / 60000;
    const techStagnationPenalty = gameTimeMinutes > 3 && tech < 2 ? 1 : 0;
    let totalEnemyDps = 0;
    let totalMyDps = 0;
    gameState.units.forEach(u => {
        const dps = this.getUnitDps(u.type) || 0;
        if (u.owner === "player" && u.health > 0) totalEnemyDps += dps;
        if (u.owner === "ai" && u.health > 0) totalMyDps += dps;
    });
    const enemyWorkers = gameState.units.filter(u => u.owner === "player" && u.type ==="worker" && u.health > 0).length;
    const myWorkers = gameState.units.filter(u => u.owner === "ai" && u.type ==="worker" && u.health > 0).length;
    const economyGap = Math.max(-1, Math.min(1, (myWorkers - enemyWorkers) / 8));      
    const enemyArmyValue = gameState.units.filter(u => u.owner === "player" && u.health > 0).reduce((sum, u) => sum + this.getUnitValue(u.type), 0);
    const myArmyValue = gameState.units.filter(u => u.owner === "ai" && u.health > 0).reduce((sum, u) => sum + this.getUnitValue(u.type), 0);
    const armyGap = Math.max(-1, Math.min(1, (myArmyValue - enemyArmyValue) / 600));
    let enemyTech = 1;
    if (gameState.buildings.some(b => b.owner === "player" && ["base2","barracks2","turret2"].includes(b.type))) enemyTech = 2;
    if (gameState.buildings.some(b => b.owner === "player" && ["base3","barracks3","turret3"].includes(b.type))) enemyTech = 3;
    const techGap = (tech - enemyTech) / 2; 
    const myPowerScore = (tech * 10) + myArmyValue + (m.aiTurrets * 5);
    const enemyPowerScore = (enemyTech * 10) + enemyArmyValue + (enemyTurrets * 5);
    const momentum = Math.tanh((myPowerScore - enemyPowerScore) / 50); 
    const progressToWin = Math.min(1, myPowerScore / 200); 
    // ==========================================
    // 🔥 ШАГ 1: ЭКОНОМИЧЕСКАЯ МАТЕМАТИКА (ТЕПЕРЬ ЗДЕСЬ, ГДЕ 'm' И 'myWorkers' УЖЕ СУЩЕСТВУЮТ)
    // ==========================================
    const totalResources = m.res.gold + m.res.silicon + m.res.plasma;
    const estimatedIncomePerSec = myWorkers * 0.5; 
    const timeToAffordWarehouse = totalResources > 0 ? (12 + 5 + 3) / (estimatedIncomePerSec || 1) : 999;
    const expansionCost = (27 + 38 + 12) + (12 + 5 + 3); // BEACON + WAREHOUSE
    const isRichEnoughToExpand = totalResources >= expansionCost ? 1 : 0;
    const totalWarehouses = m.aiWarehouses;
    const workerDeficit = Math.max(0, (totalWarehouses * 3) - myWorkers);
    const isEconomyChoked = workerDeficit > 0 ? 1 : 0;	
    // ==========================================
const emptyWh = gameState.buildings.filter(b =>
  b.owner === "ai" && b.type === "warehouse" && 
  (b.active || (b.builtAt && !b.active)) && // 🔥 Учитываем активирующиеся
  (b.workers || 0) === 0
).length;
	const emptyRatio = m.aiWarehouses > 0 ? emptyWh / m.aiWarehouses : 0;
	const income = gameState.units.filter(u => u.owner === "ai" && u.type ==="worker" && u.health > 0).length * 0.5;
	 // === ТАКТИЧЕСКАЯ ОБСТАНОВКА ===
const enemyClusters = [];
const ourClusters = [];

// Ищем скопления врагов (3+ в радиусе 200px)
const enemyCombat = gameState.units.filter(u => u.owner === "player" && u.health > 0 && ["fighter","assault","elite"].includes(u.type));
for (const e of enemyCombat) {
  const allies = enemyCombat.filter(o => o !== e && Math.hypot(o.x - e.x, o.y - e.y) < 200).length;
  if (allies >= 2) enemyClusters.push({x: e.x, y: e.y, size: allies + 1});
}

const aiCombat = gameState.units.filter(u => u.owner === "ai" && u.health > 0 && ["fighter","assault","elite"].includes(u.type));
for (const a of aiCombat) {
  const allies = aiCombat.filter(o => o !== a && Math.hypot(o.x - a.x, o.y - a.y) < 200).length;
  if (allies >= 2) ourClusters.push({x: a.x, y: a.y, size: allies + 1});
}

const enemyClusterThreat = Math.min(1, enemyClusters.length / 3);
const ourClusterStrength = Math.min(1, ourClusters.length / 2);

// Ближайшее вражеское скопление к нашей базе
let nearestEnemyClusterDist = 1.0;
for (const c of enemyClusters) {
  const d = Math.hypot(c.x - aiBase.x, c.y - aiBase.y);
  nearestEnemyClusterDist = Math.min(nearestEnemyClusterDist, d / 800);
}

// Фланговая возможность: есть ли вражеское скопление, которое можно обойти?
let flankOpportunity = 0;
if (enemyClusters.length > 0 && ourClusters.length > 0) {
  // Если враг сгруппирован с одной стороны, а у нас есть силы с другой
  const enemyCenterX = enemyClusters.reduce((s,c) => s+c.x, 0) / enemyClusters.length;
  const ourCenterX = ourClusters.reduce((s,c) => s+c.x, 0) / ourClusters.length;
  const baseX = aiBase.x;
  // Если враг и мы по разные стороны от базы — фланг открыт
  if ((enemyCenterX < baseX) !== (ourCenterX < baseX)) flankOpportunity = 1.0;
}

// Сила нашего скопления vs вражеского (для решения атаковать/отступить)
let localPowerBalance = 0;
if (ourClusters.length > 0 && enemyClusters.length > 0) {
  const ourPower = ourClusters.reduce((s,c) => s + c.size * 30, 0);
  const enemyPower = enemyClusters.reduce((s,c) => s + c.size * 30, 0);
  localPowerBalance = Math.tanh((ourPower - enemyPower) / 100);
}
	 
    return [
        threat, baseHp, enemyNear, myArmy, enemyArmy, armyBalance, techLevel,
        resTotal, warehouseCount, turretCount, timeNorm, enemyTurrets, enemyElites,
        buildingDiversity, resourceEfficiency, expansionProgress, defenseStrength,
        gameTimeMinutes / 30.0, techStagnationPenalty, economyGap, armyGap, techGap, momentum, progressToWin, Math.min(1, estimatedIncomePerSec / 5.0), 
        Math.min(1, 60 / timeToAffordWarehouse), isRichEnoughToExpand, isEconomyChoked, emptyWh, emptyRatio, income, enemyClusterThreat, ourClusterStrength, nearestEnemyClusterDist, flankOpportunity, localPowerBalance                      
    ];
},

  // 🔥 НОВАЯ ФУНКЦИЯ: Инициализация БД до начала игры
  initWeightDB: async function () {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('GnnAI_Weights_DB', 1);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('models')) {
          db.createObjectStore('models');
          console.log("[GnnAI] 🗄️ Таблица 'models' создана в IndexedDB.");
        }
      };
      req.onsuccess = (e) => {
        this.db = e.target.result; // Сохраняем соединение глобально для объекта
        console.log("[GnnAI] ✅ IndexedDB успешно инициализирована и готова к записи.");
        resolve();
      };
      req.onerror = (e) => {
        console.error("[GnnAI] ❌ Ошибка инициализации IndexedDB:", e.target.error);
        reject(e.target.error);
      };
    });
  },

    registerAction: function (action, graphState, intent, actionIndex, isExpert = false) {
      if (!graphState || !graphState.X || !graphState.A_distance) return;
      
      let currentValue = 0;
      let currentLogProb = 0;
      const actionMask = this.validActionMask();
      
      if (this.model) {
        const pred = this.predictData(graphState);
        if (pred) {
            currentValue = pred.value[0];
            const logits = pred.logits;
            const maskedLogits = logits.map((v, i) => actionMask[i] === 1 ? v : -1e9);
            const maxLogit = Math.max(...maskedLogits);
            const expLogits = maskedLogits.map(v => Math.exp(v - maxLogit));
            const sumExp = expLogits.reduce((a, b) => a + b, 0) || 1;
            const probs = expLogits.map(v => v / sumExp);
            currentLogProb = Math.log(probs[actionIndex] || 1e-10);
        }
      }

      const replayEntry = {
        X: graphState.X, 
        A_distance: graphState.A_distance, 
        A_threat: graphState.A_threat,     
        actionIndex: actionIndex !== undefined ? actionIndex : -1,
        actionMask: actionMask,       
        oldLogProb: currentLogProb,   
        value: currentValue,          
        reward: 0,
        isExpert: isExpert
      };
      // 🔥 Переносим накопленные shaping-награды на это действие
      if (this._pendingShaped) {
        replayEntry.reward += this._pendingShaped;
        this._pendingShaped = 0;
      }
      this.replay.push(replayEntry);
      this.lastReplayEntry = replayEntry;   // 🔥 теперь мир награждает ЭТО действие
      const m = this.metrics();
      const snapshot = {
        threatLevel: this.strategicMemory.threatLevel,
        aiArmy: m.aiArmy,
        resTotal: m.resTotal,
        ecoEfficiency: m.ecoEfficiency,
        techLevel: m.techLevel,
        aiBuildings: m.aiBuildings,
        aiWarehouses: m.aiWarehouses,
        aiTurrets: m.aiTurrets,
        time: performance.now(),
        baseHp: m.baseHp
      };

      if (this.episodeReport) {
        this.episodeReport.actions[action] = (this.episodeReport.actions[action] || 0) + 1;
        this.episodeReport.timeline.push({
          time: (performance.now() / 1000).toFixed(1) + ' сек',
          action: action,
          detail: intent && intent.type === "build" ? intent.buildingType : (intent && intent.type ==="hire" ? intent.unitType : intent.type),
          resources: m.resTotal,
          army: m.aiArmy,
          tech: m.techLevel
        });
      }

      if (intent && intent.unitIds && intent.unitIds.length > 0) {
        snapshot.unitStartHP = intent.unitIds.reduce((sum, id) => {
          const u = gameState.units.find(x => x.id === id);
          return sum + (u ? u.health : 0);
        }, 0);      
        if (intent.targetId) {
          const target = gameState.units.find(u => u.id === intent.targetId) || gameState.buildings.find(b => b.id === intent.targetId);
          snapshot.targetStartHP = target ? target.health : 0;
          snapshot.targetId = intent.targetId;
        }
        if (intent.anchor) {
          snapshot.anchorId = intent.anchor;
        }
      }
      if (intent && intent.type === "defend") {
          let anchor = null;
          if (intent.anchor === "aiBase") {
              anchor = window.aiBase;
          } else {
              anchor = gameState.buildings.find(b => b.id === intent.anchor);
          }     
          if (anchor) {
              snapshot.enemiesNearAnchorAtStart = gameState.units.filter(u => 
                  u.owner === "player" && u.health > 0 && Math.hypot(u.x - anchor.x, u.y - anchor.y) < 300
              ).length;
          } else {
              snapshot.enemiesNearAnchorAtStart = 0;
          }     
	 }
      this.missionCache.push({
        action: action,
        intent: intent,
        snapshot: snapshot,
        resolved: false,
        replayEntry: replayEntry
      });
		
		// 🔥 СОБЫТИЙНОЕ ЛОГИРОВАНИЕ: вешаем журнал на каждый юнит миссии
if (intent && intent.unitIds && intent.unitIds.length > 0) {
  for (const uid of intent.unitIds) {
    const u = gameState.units.find(x => x.id === uid);
    if (!u) continue;
    u.missionLog = {
      missionId: this.missionCache.length - 1,  // индекс в missionCache
      action: action,
      tactic: intent.tactic || null,
      intentType: intent.type,
      targetId: intent.targetId || null,
      targetStartHP: intent.targetId ? (gameState.units.find(x=>x.id===intent.targetId)?.health || gameState.buildings.find(b=>b.id===intent.targetId)?.health || 0) : 0,
      waypoints: intent.waypoints || [],
      startTime: performance.now(),
      events: [],          // массив событий
      damageDealt: 0,      // суммарный урон по цели
      damageTaken: 0,      // суммарный полученный урон
      killedBy: null,      // {type, id} кто убил
      deathPos: null,      // {x, y} где умер
      reachedTarget: false,
      completedMission: false,
      alive: true
    };
  }
}

      // Achievement & Immediate Rewards logic preserved...
      if (this.episodeAchievements && intent) {
          let achievementBonus = 0;
		      if (intent.type === "build") {
				if (intent.buildingType === "beacon" && !this.episodeAchievements.firstBeacon) {
					this.episodeAchievements.firstBeacon = true;
					achievementBonus = 40.0; // 🔥 Большой бонус за первый маяк
				}
              if (intent.buildingType === "barracks" && !this.episodeAchievements.firstBarracks) {
                  this.episodeAchievements.firstBarracks = true; achievementBonus = 50.0;
              } else if (intent.buildingType === "base2" && !this.episodeAchievements.firstBase2) {
                  this.episodeAchievements.firstBase2 = true; achievementBonus = 150.0; 
              } else if (intent.buildingType === "barracks2" && !this.episodeAchievements.firstBarracks2) {
                  this.episodeAchievements.firstBarracks2 = true; achievementBonus = 110.0;
              } else if (intent.buildingType === "base3" && !this.episodeAchievements.firstBase3) {
                  this.episodeAchievements.firstBase3 = true; achievementBonus = 200.0; 
              } else if (intent.buildingType === "barracks3" && !this.episodeAchievements.firstBarracks3) {
                  this.episodeAchievements.firstBarracks3 = true; achievementBonus = 150.0;
              }
          } else if (intent.type === "hire") {
              if (intent.unitType === "worker") {
                  const currentWorkers = gameState.units.filter(u => u.owner === "ai" && u.type ==="worker" && u.health > 0).length;
                  if (currentWorkers === 0) replayEntry.reward += 10.0;
              }
              if (intent.unitType === "assault" && !this.episodeAchievements.firstAssault) {
                  this.episodeAchievements.firstAssault = true; achievementBonus = 20.0;
              } else if (intent.unitType === "elite" && !this.episodeAchievements.firstElite) {
                  this.episodeAchievements.firstElite = true; achievementBonus = 30.0;
              }
          }
          if (achievementBonus > 0) replayEntry.reward += achievementBonus;
      }
      if (intent && intent.type === "hire" && ["fighter","assault","elite"].includes(intent.unitType)) {
          const workers = gameState.units.filter(u => u.owner === "ai" && u.type ==="worker" && u.health > 0).length;
          const warehouses = gameState.buildings.filter(b => b.owner === "ai" && b.type ==="warehouse" && b.active).length;
          const gameTimeMin = performance.now() / 60000;
          if (gameTimeMin > 0.5 && (workers < 2 || warehouses === 0)) {
              replayEntry.reward += -5.0; 
          }
      }
    },
	  
    checkEconomicParalysis: function(now) {
      if (!this.lastEcoCheck || now - this.lastEcoCheck < 10000) return;
      this.lastEcoCheck = now;
      const m = this.metrics();
      const gameTimeMin = performance.now() / 60000;
      const workerCount = gameState.units.filter(u => u.owner === "ai" && u.type ==="worker" && u.health > 0).length;
      const economyBuildings = gameState.buildings.filter(b => b.owner === "ai" && (b.type ==="warehouse" || b.type ==="repairWorkshop") && b.active).length;
      
      if (economyBuildings > 0 && workerCount === 0 && gameTimeMin > 0.5) {
          const currentState = this.buildGraphState();
          if (currentState) {
              this.replay.push({ X: currentState.X, A_distance: currentState.A_distance, A_threat: currentState.A_threat, actionIndex: AIDX.idle, reward: -5.0 });
          }
      }
    },

    // 🔥 МАРШРУТИЗАЦИЯ SHAPING-НАГРАД НА РЕАЛЬНОЕ ДЕЙСТВИЕ
    addShapedReward: function (reward, tag) {
      if (!isFinite(reward) || reward === 0) return;
      if (this.lastReplayEntry) {
        // Награда миру приписывается последнему реальному действию модели,
        // а не фиктивному "idle"
        this.lastReplayEntry.reward += reward;
        this.lastReplayEntry.shapedTags = this.lastReplayEntry.shapedTags || [];
        if (tag) this.lastReplayEntry.shapedTags.push(tag);
      } else {
        // Действий ещё не было — копим и отдадим первому действию
        this._pendingShaped += reward;
      }
    },

    // 🔥 Перехватываем фиктивные записи с actionIndex = idle (без actionMask)
    _wrapReplayPush: function () {
      const rb = this.replay;
      if (!rb || rb.__shapedPatched) return;
      const origPush = rb.push.bind(rb);
      const self = this;
      rb.push = function (item) {
        // Признак "фиктивной" записи评估щика: idle + нет маски действия
        if (item && item.actionIndex === AIDX.idle && !item.actionMask) {
          self.addShapedReward(item.reward, item.tag || "eval");
          return;
        }
        origPush(item);
      };
      rb.__shapedPatched = true;
    },

    getUnitValue: function(type) {
      const values = { worker: 10, repairman: 15, fighter: 30, assault: 60, elite: 120, turret: 40, turret2: 60, turret3: 80, base: 500, base2: 600, base3: 800, barracks: 50, warehouse: 30, repairWorkshop: 30, beacon: 40 };
      return values[type] || 20;
    },

    // 🔥 УМНЫЙ ПОИСК СЛАБЫХ МЕСТ НА ОСНОВЕ ГРАФА
findBestTacticalTarget: function(state, tacticType) {
  if (!state || !state.nodes) return null;
  
  // Берем только валидные ноды противника
  const enemyNodes = state.nodes.filter(n => 
    n.valid && n.owner === "player" && n.type !== "gold" && n.type !== "silicon" && n.type !== "plasma"
  );
  
  if (enemyNodes.length === 0) return null;

  let bestTarget = null;
  let bestScore = -Infinity;

  for (const node of enemyNodes) {
    let score = 0;
    // 1. Базовая ценность цели (используем наш признак targetPriority из nodeFeatures)
    if (node.type === "base" || node.type === "base2" || node.type === "base3") score += 100;
    else if (node.type === "warehouse") score += 80;
    else if (node.type === "barracks" || node.type === "barracks2" || node.type === "barracks3") score += 70;
    else if (node.type === "repairWorkshop") score += 60;
    else if (node.type.startsWith("turret")) score += 40;
    else score += 20; // юниты

    // 2. ШТРАФ за близость вражеских скоплений (используем признаки из графа)
    // Если рядом много врагов (enemyClusterNear) или высокая угроза, снижаем score
    // Мы можем оценить это, посчитав вражеские ноды в радиусе 250px от этой цели
    const nearbyThreat = enemyNodes.filter(other => {
      if (other === node) return false;
      const dist = Math.hypot(node.x - other.x, node.y - other.y);
      return dist < 250;
    }).length;

    if (nearbyThreat >= 3) score -= 60;      // Сильная оборона (кластер)
    else if (nearbyThreat >= 2) score -= 30;  // Средняя оборона
    else if (nearbyThreat === 0) score += 40; // Изолированная цель! (Идеально для harassment)

    // 3. Специфика тактики
    if (tacticType === "flank_attack" || tacticType === "strike_weak") {
      // Для фланга и слабого места мы ИЩЕМ изолированные ценные цели
      if (nearbyThreat === 0 && (node.type === "warehouse" || node.type === "barracks" || node.type.includes("base"))) {
        score += 100; // Огромный бонус за изолированную экономику/базу
      }
    } else if (tacticType === "tactic_push" || tacticType === "tactic_all_in") {
      // Для пуша мы готовы атаковать кластеры, если у нас есть перевес
      // (Это упрощенная проверка, можно улучшить, сравнивая ourClusterStrength)
      score += nearbyThreat * 5; 
    }

    if (score > bestScore) {
      bestScore = score;
      bestTarget = node;
    }
  }

  return bestTarget;
},

evaluateMissions: function () {
  for (let i = this.missionCache.length - 1; i >= 0; i--) {
    const mission = this.missionCache[i];
    if (mission.resolved) {
      this.missionCache.splice(i, 1);
      continue;
    }
    
    let rewardDelta = 0;
    let isResolved = false;
    let reason = "";
    const m = this.metrics();

// 🔥 1. АТАКА (СОБЫТИЙНАЯ ЛОГИКА) — ИСПРАВЛЕННАЯ ВЕРСИЯ
if (mission.intent.type === "attack") {
  const unitIds = mission.intent.unitIds || [];
  const logs = unitIds.map(id => {
    const u = gameState.units.find(x => x.id === id);
    return u ? u.missionLog : null;
  }).filter(Boolean);
  
  if (logs.length > 0) {
    const alive = logs.filter(l => l.alive);
    const dead = logs.filter(l => !l.alive);
    const completed = logs.filter(l => l.completedMission);
    const reached = logs.filter(l => l.reachedTarget);
    const totalDamageDealt = logs.reduce((s, l) => s + l.damageDealt, 0);
    const totalDamageTaken = logs.reduce((s, l) => s + l.damageTaken, 0);
    const hitByTurret = logs.some(l => l.hitByTurret);
    const diedToTurret = dead.some(l => l.killedBy && l.killedBy.type && l.killedBy.type.startsWith("turret"));
    
    // 🔥 ИСПРАВЛЕНИЕ: Получаем тип цели для оценки важности
    const target = gameState.units.find(u => u.id === mission.snapshot.targetId) || 
                   gameState.buildings.find(b => b.id === mission.snapshot.targetId);
    const targetType = target ? target.type : "unknown";
    
    // 🔥 ФУНКЦИЯ ОЦЕНКИ ВАЖНОСТИ ЦЕЛИ
    const getTargetImportance = (type) => {
      if (type === "base" || type === "base2" || type === "base3") return 100;
      if (type === "warehouse") return 80;
      if (type === "barracks" || type === "barracks2" || type === "barracks3") return 70;
      if (type === "repairWorkshop") return 60;
      if (type && type.startsWith("turret")) return 50;
      if (type === "beacon") return 40;
      if (type === "worker") return 15; // 🔥 НИЗКАЯ ВАЖНОСТЬ
      if (type === "fighter") return 20;
      if (type === "assault") return 30;
      if (type === "elite") return 40;
      return 10;
    };
    
    const targetImportance = getTargetImportance(targetType);
    
    let resolved = false;
    let tacticReward = 0;
    let eventReason = "";
    
    // 1. Все юниты мертвы
    if (alive.length === 0 && dead.length > 0) {
      resolved = true;
      if (completed.length > 0) {
        // 🔥 ИСПРАВЛЕНИЕ: Награда зависит от важности цели
        const baseReward = targetImportance >= 50 ? 30.0 : 10.0; // 🔥 Было 30 для всех
        tacticReward = baseReward + totalDamageDealt * 0.1;
        eventReason = `HEROIC_SACRIFICE: все погибли, но ${targetType} уничтожена (важность: ${targetImportance})`;
      } else if (reached.length > 0) {
        tacticReward = -5.0 + totalDamageDealt * 0.05;
        eventReason = "REACHED_BUT_DIED: дошли до цели, но не уничтожили";
      } else if (diedToTurret) {
        tacticReward = -20.0;
        eventReason = "DIED_TO_TURRETS: попали под турели, не достигнув цели";
      } else {
        tacticReward = -10.0;
        eventReason = "TOTAL_WIPEOUT: армия уничтожена без результата";
      }
    }
    // 2. Все живы и цель уничтожена
    else if (completed.length === logs.length && alive.length === logs.length) {
      resolved = true;
      // 🔥 ИСПРАВЛЕНИЕ: Награда зависит от важности цели
      let baseReward = 0;
      if (targetImportance >= 80) {
        // Важные цели (база, склад, казарма) — большая награда
        baseReward = 80.0;
      } else if (targetImportance >= 50) {
        // Средние цели (турель, маяк) — средняя награда
        baseReward = 40.0;
      } else if (targetImportance >= 30) {
        // Низкие цели (assault, elite) — малая награда
        baseReward = 20.0;
      } else {
        // Слабые цели (worker, fighter) — минимальная награда
        baseReward = 10.0;
      }
      
      tacticReward = baseReward + totalDamageDealt * 0.25;
      eventReason = `PERFECT_STRIKE: все вернулись, ${targetType} уничтожена (важность: ${targetImportance}, база: ${baseReward})`;
    }
    // 3. Цель уничтожена, но есть потери
    else if (completed.length > 0) {
      resolved = true;
      const lossRatio = dead.length / logs.length;
      // 🔥 ИСПРАВЛЕНИЕ: Базовая награда зависит от важности цели
      let baseReward = 0;
      if (targetImportance >= 80) {
        baseReward = 50.0;
      } else if (targetImportance >= 50) {
        baseReward = 30.0;
      } else if (targetImportance >= 30) {
        baseReward = 15.0;
      } else {
        baseReward = 5.0;
      }
      
      tacticReward = baseReward - lossRatio * 15.0 + totalDamageDealt * 0.15;
      eventReason = `TARGET_KILLED_LOSS_${Math.round(lossRatio*100)}%: потери ${dead.length}/${logs.length}, ${targetType} (важность: ${targetImportance})`;
    }
    // 4. Часть дошла, часть жива — продолжаем наблюдать
    else if (reached.length > 0 && alive.length > 0) {
      tacticReward = totalDamageDealt * 0.05;
      eventReason = "IN_PROGRESS: бой идёт";
    }
    // 5. Все живы, но ни один не дошёл (застряли)
    else if (alive.length === logs.length && reached.length === 0) {
      const stuckTime = (performance.now() - mission.snapshot.time) / 1000;
      if (stuckTime > 20) {
        resolved = true;
        tacticReward = -15.0;
        eventReason = `STUCK_NO_PROGRESS: ${stuckTime.toFixed(0)}с без достижения цели`;
      }
    }
    
    // === ТАКТИЧЕСКИЕ БОНУСЫ (применяются только если миссия разрешена) ===
    if (resolved) {
      const noClusterDamage = logs.every(l => l.damageTaken < 50);
      if (mission.snapshot.enemyClusterNear && noClusterDamage && completed.length > 0) {
        tacticReward += 25.0;
        eventReason += " +CLEVER_FLANK";
      }
      if (diedToTurret && dead.length > 0) {
        tacticReward -= 15.0;
        eventReason += " +FRONTAL_TURRET_ASSAULT";
      }
      if (mission.snapshot.targetStartHP && mission.snapshot.targetStartHP < 100 && completed.length > 0) {
        tacticReward += 10.0;
        eventReason += " +FINISHING_BLOW";
      }
      
      // 🔥 ИСПРАВЛЕНИЕ: Бонус за эффективность только если цель важная
      const efficiency = totalDamageDealt / Math.max(1, totalDamageTaken);
      if (efficiency > 3 && completed.length > 0 && targetImportance >= 50) {
        tacticReward += 15.0;
        eventReason += ` +EFFICIENT_${efficiency.toFixed(1)}x`;
      }
      
      if (target && completed.length > 0) {
        tacticReward += targetImportance;
        eventReason += ` +${targetType.toUpperCase()}_DESTROYED`;
      }
      
      // 🔥 НОВОЕ: Штраф за атаку слабых целей (рабочих)
      if (targetType === "worker" && completed.length > 0) {
        const workerPenalty = -5.0;
        tacticReward += workerPenalty;
        eventReason += " +WORKER_HARASS_PENALTY";
      }
      
      // Сохраняем контекст в replay для обучения креативности
      if (mission.replayEntry) {
        mission.replayEntry.tacticalContext = {
          totalDamageDealt, totalDamageTaken,
          lossRatio: dead.length / Math.max(1, logs.length),
          hitByTurret, completedMission: completed.length > 0,
          efficiency: totalDamageDealt / Math.max(1, totalDamageTaken),
          targetImportance
        };
      }
      
      // Очистка журналов после разрешения миссии
      for (const uid of unitIds) {
        const u = gameState.units.find(x => x.id === uid);
        if (u && u.missionLog) u.missionLog = null;
      }
      
      const missionTime = (performance.now() - mission.snapshot.time) / 1000;
      if (missionTime < 15 && completed.length > 0) {
        tacticReward += 20.0;
        eventReason += " +BLITZ_EXECUTION";
      }
      
      // 🔥 НОВОЕ: Бонус за эффективное использование армии (мало юнитов — большой урон)
      if (completed.length > 0 && logs.length <= 3 && totalDamageDealt > 200 && targetImportance >= 50) {
        tacticReward += 25.0;
        eventReason += " +ELITE_SQUAD";
      }
    }
    
    rewardDelta += tacticReward;
    reason = eventReason;
    isResolved = resolved;
  }
}
    // ==========================================
// 🔥 2. ЗАЩИТА (DEFEND) — ИСПРАВЛЕННАЯ ВЕРСИЯ
// ==========================================
else if (mission.intent.type === "defend") {
  const anchor = (mission.snapshot.anchorId === "aiBase") ? window.aiBase : gameState.buildings.find(b => b.id === mission.snapshot.anchorId);
  let enemiesNearAnchorNow = 0;
  if (anchor) {
    enemiesNearAnchorNow = gameState.units.filter(u => u.owner === "player" && u.health > 0 && Math.hypot(u.x - anchor.x, u.y - anchor.y) < 300).length;
  }
  const enemiesAtStart = mission.snapshot.enemiesNearAnchorAtStart || 0;
  const aliveDefenders = (mission.intent.unitIds || []).reduce((sum, id) => {
    const u = gameState.units.find(x => x.id === id);
    return sum + (u && u.health > 0 ? 1 : 0);
  }, 0);
  const totalDefendersAtStart = mission.intent.unitIds ? mission.intent.unitIds.length : 0;
  
  // 🔥 ИСПРАВЛЕНИЕ: Проверяем, что враг ДЕЙСТВИТЕЛЬНО был рядом в начале миссии
  // И что армия реально сражалась (нанесла урон или потеряла юнитов)
  const missionDuration = (performance.now() - mission.snapshot.time) / 1000; // в секундах
  
  // Считаем урон, нанесённый защитниками (если есть журналы)
  const unitIds = mission.intent.unitIds || [];
  const logs = unitIds.map(id => {
    const u = gameState.units.find(x => x.id === id);
    return u ? u.missionLog : null;
  }).filter(Boolean);
  
  const totalDamageDealt = logs.reduce((s, l) => s + (l.damageDealt || 0), 0);
  const totalDamageTaken = logs.reduce((s, l) => s + (l.damageTaken || 0), 0);
  const lostDefenders = totalDefendersAtStart - aliveDefenders;
  
  // ✅ НАГРАДА ТОЛЬКО ЕСЛИ БЫЛ РЕАЛЬНЫЙ БОЙ
  if (enemiesAtStart > 0 && enemiesNearAnchorNow === 0 && aliveDefenders > 0) {
    // Проверяем, что защитники реально сражались
    const hadRealCombat = totalDamageDealt > 50 || totalDamageTaken > 30 || lostDefenders > 0;
    
    if (hadRealCombat) {
      // Награда пропорциональна эффективности боя
      const efficiency = totalDamageDealt / Math.max(1, totalDamageTaken);
      const combatReward = Math.min(60.0, 20.0 + efficiency * 10.0 + lostDefenders * 5.0);
      rewardDelta = combatReward;
      reason = `successful_defense_OUTCOME: урон ${totalDamageDealt.toFixed(0)}, потери ${lostDefenders}, эффективность ${efficiency.toFixed(2)}`;
      isResolved = true;
    } else {
      // Враг был, но защитники не сражались (стояли в стороне)
      rewardDelta = -10.0;
      reason = "DEFEND_WITHOUT_COMBAT: защитники не вступили в бой";
      isResolved = true;
    }
  }
  // ✅ ШТРАФ ЗА ЗАЩИТУ ПУСТОТЫ
  else if (enemiesAtStart === 0 && enemiesNearAnchorNow === 0) {
    // Проверяем, не было ли врагов рядом в последние 10 секунд
    const recentEnemyPresence = gameState.units.some(u => 
      u.owner === "player" && u.health > 0 && anchor &&
      Math.hypot(u.x - anchor.x, u.y - anchor.y) < 500
    );
    
    if (recentEnemyPresence) {
      // Враг был недавно, но ушёл — небольшая награда за превентивную защиту
      rewardDelta = 5.0;
      reason = "PREVENTIVE_DEFENSE: враг был рядом, но ушёл";
      isResolved = true;
    } else {
      // Врага не было и нет — штраф за ложную тревогу
      rewardDelta = -30.0;
      reason = "defending_nothing_penalty: врага нет и не было";
      isResolved = true;
    }
  }
  // ✅ ШТРАФ ЗА ПОТЕРЮ ВСЕХ ЗАЩИТНИКОВ
  else if (totalDefendersAtStart > 0 && aliveDefenders === 0) {
    rewardDelta = -60.0;
    reason = "all_defenders_lost_OUTCOME";
    isResolved = true;
  }
  // ✅ НЕБОЛЬШАЯ НАГРАДА ЗА АКТИВНУЮ ОБОРОНУ
  else if (enemiesNearAnchorNow > 0 && aliveDefenders > 0) {
    // Награда за каждый тик боя (стимулирует не уходить)
    rewardDelta = 0.5 + (totalDamageDealt > 0 ? 0.3 : 0);
  }
}
    // 🔥 3. НАЙМ (HIRE)
    else if (mission.intent.type === "hire") {
      if (this.metrics().aiArmy > mission.snapshot.aiArmy || mission.intent.unitType === "worker" || mission.intent.unitType === "repairman") {
        const type = mission.intent.unitType;
        let hireReward = 0;
        
        const totalWorkers = gameState.units.filter(u => u.owner === "ai" && u.type === "worker" && u.health > 0).length;
        const totalWarehouses = gameState.buildings.filter(b => b.owner === "ai" && b.type === "warehouse" && b.active).length;
        const totalWorkshops = gameState.buildings.filter(b => b.owner === "ai" && b.type === "repairWorkshop" && b.active).length;
        const neededWorkers = totalWarehouses * 3 + totalWorkshops * 2;

        if (type === "worker") {
          if (totalWorkers < neededWorkers) { hireReward = 8.0; reason = "worker_filled_deficit"; } 
          else { hireReward = 1.0; reason = "worker_hired"; }
        }
        else if (type === "repairman") { hireReward = 2.0; reason = "repairman_hired"; }
        else if (type === "fighter") { hireReward = (m.aiArmy === 0) ? 15.0 : 2.0; reason = m.aiArmy === 0 ? "FIRST_BLOOD_UNIT_HIRED" : "fighter_hired"; }
        else if (type === "assault") { hireReward = 3.0; }
        else if (type === "elite") { hireReward = 5.0; }
        
        rewardDelta = hireReward;
        reason = reason || `unit_hired_${type}_reward`;
        isResolved = true;
      } else {
        const elapsed = performance.now() - mission.snapshot.time;
        if (elapsed > 10000) { rewardDelta = -1.0; reason = "hire_failed_or_timeout_penalty"; isResolved = true; }
      }
    }
    // 🔥 4. СТРОИТЕЛЬСТВО (BUILD)
    else if (mission.intent.type === "build") {
      const bt = mission.intent.buildingType;
      const isBuilt = gameState.buildings.some(b => b.owner === "ai" && b.type === bt && b.active);
      if (isBuilt) {
        const prev = mission.snapshot;
        let reasonBuild = "";

        if (bt === "warehouse" || bt === "repairWorkshop") {
          const totalWorkers = gameState.units.filter(u => u.owner === "ai" && u.type === "worker" && u.health > 0).length;
          const totalWarehouses = gameState.buildings.filter(b => b.owner === "ai" && b.type === "warehouse" && b.active).length;
          const totalWorkshops = gameState.buildings.filter(b => b.owner === "ai" && b.type === "repairWorkshop" && b.active).length;
          const neededWorkers = totalWarehouses * 3 + totalWorkshops * 2;
          const gameTimeMin = performance.now() / 60000;
          const emptyWarehouses = gameState.buildings.filter(b => b.owner === "ai" && b.type === "warehouse" && b.active && (b.workers || 0) === 0).length;
          
          if (totalWorkers < neededWorkers) {
            const deficit = neededWorkers - totalWorkers;
            rewardDelta -= 15.0 * deficit;
            reasonBuild = `WORKER_DEFICIT_CRITICAL: не хватает ${deficit} рабочих, ${emptyWarehouses} складов пустуют!`;
          } else if (emptyWarehouses > 0 && gameTimeMin > 1.5) {
            rewardDelta -= 12.0 * emptyWarehouses;
            reasonBuild = `EMPTY_WAREHOUSES_PENALTY: ${emptyWarehouses} складов без рабочих!`;
          } else {
            rewardDelta += 3.0;
            reasonBuild = "INFRASTRUCTURE_WITH_WORKERS";
          }
        }
        else if (this.BUILD_BONUSES[bt] !== undefined) {
          rewardDelta += this.BUILD_BONUSES[bt];
          if (this.BUILD_TIER_GOALS[bt]) this.tierGoalsMet[this.BUILD_TIER_GOALS[bt]] = true;
          reasonBuild = bt.toUpperCase() + "_BUILT";
        }
        else if (bt.startsWith("turret")) {
          rewardDelta += 15.0;
          reasonBuild = "TURRET_BUILT";
          const builtObj = gameState.buildings.find(b => b.owner === "ai" && b.type === bt && b.active);
          if (builtObj) {
            const nearBeacon = gameState.buildings.some(b => b.owner === "ai" && b.type === "beacon" && Math.hypot(b.x - builtObj.x, b.y - builtObj.y) < 250);
            const nearBase = Math.hypot(builtObj.x - aiBase.x, builtObj.y - aiBase.y) < 400;
            if (nearBeacon) { rewardDelta += 25.0; reasonBuild += "_FORT_TURRET_BUILT"; } 
            else if (!nearBase) { rewardDelta -= 20.0; reasonBuild += "_TURRET_IN_VOID_PENALTY"; }
          }
        }
        else if (bt === "beacon") {
          const beaconCount = gameState.buildings.filter(b => b.owner === "ai" && b.type === "beacon" && b.active).length;
          const newBeacon = gameState.buildings.find(b => b.owner === "ai" && b.type === "beacon" && b.active && !b.rewarded);
          let sectorScore = 0;
          if (newBeacon) {
            if (gameState.buildings.some(b => b.owner === "ai" && b.type === "warehouse" && b.active && Math.hypot(b.x - newBeacon.x, b.y - newBeacon.y) < 250)) sectorScore += 1;
            if (gameState.buildings.some(b => b.owner === "ai" && b.type.startsWith("turret") && b.active && Math.hypot(b.x - newBeacon.x, b.y - newBeacon.y) < 250)) sectorScore += 1;
            if (gameState.resources.some(r => r.amount > 20 && Math.hypot(r.x - newBeacon.x, r.y - newBeacon.y) < 300)) sectorScore += 1;
            if (gameState.units.some(u => u.owner === "ai" && u.type === "worker" && u.health > 0 && Math.hypot(u.x - newBeacon.x, u.y - newBeacon.y) < 300)) sectorScore += 1;
            newBeacon.rewarded = true;
          }
          if (beaconCount > 3) { rewardDelta -= 40.0; reasonBuild = "BEACON_SPAM_CRITICAL"; } 
          else if (sectorScore === 4) { rewardDelta += 50.0; reasonBuild = "PERFECT_SECTOR_COMPLETE"; } 
          else if (sectorScore === 3) { rewardDelta += 30.0; reasonBuild = "SECTOR_ALMOST_COMPLETE"; } 
          else if (sectorScore === 2) { rewardDelta += 15.0; reasonBuild = "SECTOR_PARTIAL"; } 
          else if (sectorScore === 1) { rewardDelta += 5.0; reasonBuild = "SECTOR_STARTED"; } 
          else { rewardDelta -= 25.0; reasonBuild = "BEACON_IN_VOID_PENALTY"; }
        }
        else {
          rewardDelta += 5.0;
          reasonBuild = "building_bonus";
        }
        if (["warehouse","repairWorkshop","turret","turret2","turret3"].includes(bt)) {
          const builtObj = gameState.buildings.find(b => b.owner === "ai" && b.type === bt && b.active);
          if (builtObj) {
            const nearBeacon = gameState.buildings.some(b => b.owner === "ai" && b.type === "beacon" && Math.hypot(b.x - builtObj.x, b.y - builtObj.y) < 220);
            if (nearBeacon) {
              if (bt.startsWith("turret")) { rewardDelta += 40.0; reasonBuild += "_FORT_TURRET_BUILT"; } 
              else { rewardDelta += 25.0; reasonBuild += "_CLUSTER_ON_OUTPOST"; }
            }
          }
        }
        if (bt === "warehouse" && m.aiWarehouses > 5) { rewardDelta -= 2.0; reasonBuild += "_DIMINISHING"; }
        if (bt === "repairWorkshop") {
          const workshops = gameState.buildings.filter(b => b.owner === "ai" && b.type === "repairWorkshop" && b.active).length;
          if (workshops > 2) { rewardDelta -= 10.0; reasonBuild = "REPAIR_WORKSHOP_SPAM: 3+ мастерских без необходимости!"; }
        }
        else if (["warehouse","repairWorkshop"].includes(bt)) {
          if (m.aiArmy > prev.aiArmy || m.resTotal < prev.resTotal) { rewardDelta += 3.0; reasonBuild = "eco_utilized"; }
          else { rewardDelta -= 1.0; reasonBuild = "eco_stagnation"; }
        }
        if (["warehouse","repairWorkshop","turret","turret2","turret3","barracks","barracks2","barracks3"].includes(bt)) {
          const builtObj = gameState.buildings.find(b => b.owner === "ai" && b.type === bt && b.active);
          if (builtObj) {
            const distFromBase = Math.hypot(builtObj.x - aiBase.x, builtObj.y - aiBase.y);
            if (distFromBase > 400) {
              const expansionBonus = Math.min(20.0, (distFromBase - 400) / 50);
              rewardDelta += expansionBonus;
              reasonBuild += `_EXPANSION_BONUS_${expansionBonus.toFixed(1)}`;
            }
          }
        }
        rewardDelta = Math.round(rewardDelta * 10) / 10;
        reason = `build_consequence_${reasonBuild}`;
        isResolved = true;
      } else {
        const elapsed = performance.now() - mission.snapshot.time;
        if (elapsed > 30000) { rewardDelta = -5.0; reason = "build_timeout"; isResolved = true; }
      }
    }

// 🔥 5. БЕЗДЕЙСТВИЕ (IDLE) — ИСПРАВЛЕННАЯ ВЕРСИЯ
else if (mission.intent.type === "idle") {
  const gameTimeMin = performance.now() / 60000;
  const totalResRaw = (m.res.gold || 0) + (m.res.silicon || 0) + (m.res.plasma || 0);
  
  // 🔥 ИСПРАВЛЕНИЕ: Считаем РЕАЛЬНУЮ стоимость следующих целей
  const costBase2 = (typeof BASE2_COST !== 'undefined') ? (BASE2_COST.gold + BASE2_COST.silicon + BASE2_COST.plasma) : 200;
  const costBarracks2 = (typeof BARRACKS2_COST !== 'undefined') ? (BARRACKS2_COST.gold + BARRACKS2_COST.silicon + BARRACKS2_COST.plasma) : 150;
  const costExpansion = (typeof BEACON_COST !== 'undefined') ? (BEACON_COST.gold + BEACON_COST.silicon + BEACON_COST.plasma + WAREHOUSE_COST.gold + WAREHOUSE_COST.silicon + WAREHOUSE_COST.plasma + WORKER_COST.gold * 2) : 100;
  
  // 🔥 НОВОЕ: Определяем, какая цель реально нужна ИИ
  const hasBarracks = gameState.buildings.some(b => b.owner === "ai" && b.type === "barracks" && b.active);
  const hasBase2 = gameState.buildings.some(b => 
    b.owner === "ai" && b.type === "base2" && 
    (b.active || (b.builtAt && !b.active)) // 🔥 Учитываем активирующиеся
  );  
  const hasBarracks2 = gameState.buildings.some(b => b.owner === "ai" && b.type === "barracks2" && b.active);
  const warehouseCount = gameState.buildings.filter(b => b.owner === "ai" && b.type === "warehouse" && b.active).length;
  const workerCount = gameState.units.filter(u => u.owner === "ai" && u.type === "worker" && u.health > 0).length;
  // 🔥 КРИТИЧЕСКИЕ ЦЕЛИ (должны быть построены как можно скорее)
  let criticalGoalCost = 9999;
  let criticalGoalName = "none";
  
  if (!hasBarracks && gameTimeMin > 1.5) {
    criticalGoalCost = (typeof BARRACKS_COST !== 'undefined') ? (BARRACKS_COST.gold + BARRACKS_COST.silicon + BARRACKS_COST.plasma) : 100;
    criticalGoalName = "barracks";
  } else if (!hasBase2 && hasBarracks && gameTimeMin > 3.0) {
    criticalGoalCost = costBase2;
    criticalGoalName = "base2";
  } else if (warehouseCount < 2 && gameTimeMin > 1.0) {
    criticalGoalCost = (typeof WAREHOUSE_COST !== 'undefined') ? (WAREHOUSE_COST.gold + WAREHOUSE_COST.silicon + WAREHOUSE_COST.plasma) : 50;
    criticalGoalName = "warehouse";
  } else if (workerCount < warehouseCount * 3 && gameTimeMin > 1.0) {
    criticalGoalCost = (typeof WORKER_COST !== 'undefined') ? (WORKER_COST.gold + WORKER_COST.silicon + WORKER_COST.plasma) : 20;
    criticalGoalName = "worker";
  }
  // 🔥 НОВОЕ: Проверяем, есть ли что-то, что ИИ МОЖЕТ построить прямо сейчас
  const canBuildSomething = totalResRaw >= criticalGoalCost * 0.8;

  if (canBuildSomething && criticalGoalName !== "none") {
    // 🔥 ШТРАФ: Ресурсов хватает на критическую цель, но ИИ бездействует
    const hoardingPenalty = -10.0;
    rewardDelta = hoardingPenalty;
    reason = `HOARDING_CRITICAL: Ресурсов хватает на ${criticalGoalName} (${totalResRaw.toFixed(0)}/${criticalGoalCost.toFixed(0)}), но ИИ бездействует!`;
  }
  else if (totalResRaw >= criticalGoalCost * 0.6 && criticalGoalName !== "none") {
    // 🔥 ШТРАФ: Почти хватило на цель, но ИИ не инвестирует
    const nearGoalPenalty = -3.0;
    rewardDelta = nearGoalPenalty;
    reason = `NEAR_CRITICAL_GOAL: Почти накопили на ${criticalGoalName} (${totalResRaw.toFixed(0)}/${criticalGoalCost.toFixed(0)})`;
  }
  else if (totalResRaw > 30 && criticalGoalName === "none") {
    // 🔥 НОВОЕ: Небольшая награда ТОЛЬКО если нет критических целей
    // (например, все базовые здания построены, копим на экспансию)
    const strategicSaving = 1.0;
    rewardDelta = strategicSaving;
    reason = "STRATEGIC_SAVING: Копим на экспансию (нет критических целей)";
  }
  else {
    // Законный простой: ресурсов мало, критических целей нет
    rewardDelta = 0.0;
    reason = "WAITING_FOR_RESOURCES: Законный простой, копим с нуля";
  }
  // 🔥 НОВОЕ: Штраф за долгое бездействие с ресурсами
  if (gameTimeMin > 3.0 && m.aiArmy === 0 && totalResRaw > 100) {
    rewardDelta -= 5.0;
    reason += " + NO_ARMY_PANIC: 3+ минуты без армии при ресурсах > 100!";
  }
  // 🔥 НОВОЕ: Штраф за бездействие при наличии врагов рядом
  if (m.enemyNear > 0 && totalResRaw > 50) {
    rewardDelta -= 8.0;
    reason += " + IDLE_UNDER_THREAT: Враг рядом, а ИИ бездействует!";
  }
  isResolved = true;
}
    // 🔥 6. ПРИМЕНЕНИЕ НАГРАДЫ
    if (isResolved || rewardDelta !== 0) {
      // 🔥 Было ±15 — убивало награду за базу (+180) и Тир-бонусы.
      // Теперь тактические исходы сохраняют реальный вес.
      const clippedDelta = Math.max(-200.0, Math.min(200.0, rewardDelta));      mission.replayEntry.reward += clippedDelta;
      if (Math.abs(clippedDelta) > 1.0 || reason.includes("OUTCOME") || reason.includes("penalty")) {
        console.log(`[GnnAI Cache] 🎯 '${mission.action}' → ${clippedDelta >= 0 ? '+' : ''}${clippedDelta.toFixed(2)} (${reason})`);
      }
      if (isResolved) mission.resolved = true;
    }
  }
},

// ==========================================
// 🔥 ОЦЕНКА СТАГНАЦИИ — ИСПРАВЛЕННАЯ ВЕРСИЯ
// ==========================================
evaluateStagnation: function (now) {
   if (now - this.lastStagnationCheck < 5000) return;
   this.lastStagnationCheck = now;
   const m = this.metrics();
   const gameTimeMin = performance.now() / 60000;
   let penalty = 0;
   let reasons = [];
   
   const workers = gameState.units.filter(u => u.owner === "ai" && u.type === "worker" && u.health > 0).length;
   
   // 🔥 КРИТИЧЕСКИЕ ШТРАФЫ (усилены)
   if (gameTimeMin > 2.5 && m.aiWarehouses < 2) { 
     penalty -= 30.0; 
     reasons.push("SEVERE_STAGNATION: ONLY_1_WAREHOUSE_LATE_GAME"); 
   }
   if (gameTimeMin > 3.0 && workers < 4) { 
     penalty -= 25.0; 
     reasons.push("SEVERE_STAGNATION: LESS_THAN_4_WORKERS_LATE_GAME"); 
   }
   
// ==========================================
// 🔥 БОНУС ЗА РЕАЛЬНОЕ ПОКРЫТИЕ РАНЕНЫХ — ИСПРАВЛЕННАЯ ВЕРСИЯ
// ==========================================
const repairmen = gameState.units.filter(u => 
  u.owner === "ai" && u.type === "repairman" && u.health > 0
).length;
const woundedUnits = gameState.units.filter(u => 
  u.owner === "ai" && u.health > 0 && u.health < u.maxHealth * 0.5
).length;

// 🔥 ИСПРАВЛЕНИЕ: Награда только если ремонтники РЕАЛЬНО работают (юниты быстро восстанавливаются)
if (repairmen > 0 && woundedUnits > 0 && repairmen >= Math.ceil(woundedUnits / 3)) {
  // 🔥 НОВОЕ: Проверяем, что юниты действительно лечатся (HP растёт)
  let healingProgress = 0;
  const woundedCombatUnits = gameState.units.filter(u => 
    u.owner === "ai" && ["fighter", "assault", "elite"].includes(u.type) && 
    u.health > 0 && u.health < u.maxHealth * 0.7
  );
  
  // Считаем, сколько раненых юнитов находятся рядом с мастерскими (лечатся)
  const workshops = gameState.buildings.filter(b => 
    b.owner === "ai" && b.type === "repairWorkshop" && b.active
  );
  
  let healingUnits = 0;
  woundedCombatUnits.forEach(u => {
    const nearWorkshop = workshops.some(w => 
      Math.hypot(u.x - w.x, u.y - w.y) < 200
    );
    if (nearWorkshop) healingUnits++;
  });
  
  // 🔥 Награда только если юниты реально лечатся (а не просто стоят раненые)
  if (healingUnits >= Math.ceil(woundedCombatUnits.length * 0.5)) {
    // Половина раненых юнитов лечится — небольшая награда
    const healingBonus = Math.min(2.0, healingUnits * 0.5);
    penalty += healingBonus;
    reasons.push(`REPAIR_COVERING_WOUNDED: ${healingUnits}/${woundedCombatUnits.length} раненых лечатся (+${healingBonus.toFixed(1)})`);
  } else if (woundedCombatUnits.length >= 3 && gameTimeMin > 2.0) {
    // 🔥 ШТРАФ: Много раненых, но они не лечатся (ИИ избегает боёв)
    const avoidCombatPenalty = -5.0;
    penalty += avoidCombatPenalty;
    reasons.push(`AVOIDING_COMBAT: ${woundedCombatUnits.length} раненых, но только ${healingUnits} лечатся!`);
  }
}

// 🔥 НОВОЕ: Штраф за избыточное количество ремонтников
const optimalRepairmen = Math.ceil(woundedUnits / 3);
if (repairmen > optimalRepairmen + 2 && repairmen > 3) {
  const excessRepairmen = repairmen - optimalRepairmen;
  const repairSpamPenalty = -3.0 * Math.min(5, excessRepairmen);
  penalty += repairSpamPenalty;
  reasons.push(`REPAIR_SPAM: ${repairmen} ремонтников, но нужно только ${optimalRepairmen} (штраф ${repairSpamPenalty.toFixed(1)})`);
}
   // 🔥 Штраф за накопление ресурсов без инвестиций
   if (m.resTotal > 0.15 && m.aiArmy === this.lastArmySize && m.aiBuildings === this.lastBuildingCount) { 
     penalty -= 2.0; 
     reasons.push("resource_hoarding_without_investment"); 
   }

   // 🔥 ИСПРАВЛЕНИЕ №1: УСИЛЕННЫЙ ШТРАФ ЗА TURTLE STRATEGY
   const turretCount = gameState.buildings.filter(b => 
     b.owner === "ai" && b.type?.startsWith("turret") && b.health > 0
   ).length;
   
   if (m.aiTurrets >= 4 && m.aiArmy < 3 && gameTimeMin > 4) { 
     // 🔥 БЫЛО: -3.0 → СТАЛО: -25.0 (усилено в 8 раз!)
     penalty -= 25.0; 
     reasons.push("TURTLE_STRATEGY_CRITICAL: 4+ турели, но <3 бойцов после 4 мин!"); 
   }
   
   // 🔥 НОВОЕ: Штраф за "полу-тартл" (2-3 турели, но 0 бойцов)
   if (turretCount >= 2 && m.aiArmy === 0 && gameTimeMin > 3) {
     penalty -= 15.0;
     reasons.push("TURTLE_LITE: есть турели, но НЕТ армии после 3 мин!");
   }
   
   // 🔥 НОВОЕ: Штраф за "полный тартл" (5+ турелей, но <5 бойцов)
   if (turretCount >= 5 && m.aiArmy < 5 && gameTimeMin > 5) {
     penalty -= 40.0;
     reasons.push("FULL_TURTLE_PENALTY: 5+ турелей, но <5 бойцов после 5 мин!");
   }
   // 🔥 НОВОЕ: Штраф за отсутствие атак (модель не атакует вообще)
   const recentAttacks = this.missionCache.filter(m => 
     !m.resolved && m.intent.type === "attack"
   ).length;
   const completedAttacks = this.episodeReport?.actions?.attack_front || 
                            this.episodeReport?.actions?.strike_weak || 
                            this.episodeReport?.actions?.focus_fire || 
                            this.episodeReport?.actions?.flank_attack || 0;
   if (gameTimeMin > 3.0 && m.aiArmy >= 2 && recentAttacks === 0 && completedAttacks === 0) {
     penalty -= 20.0;
     reasons.push("NO_ATTACKS_PENALTY: армия есть, но атак НЕТ после 3 мин!");
   }
   // 🔥 НОВОЕ: Штраф за долгое отсутствие атак (даже если были раньше)
   if (gameTimeMin > 5.0 && m.aiArmy >= 3 && completedAttacks === 0) {
     penalty -= 30.0;
     reasons.push("ZERO_ATTACKS_5MIN: 5 минут без единой атаки!");
   }
   if (gameTimeMin > 5 && m.techLevel === 1) { 
     penalty -= 5; 
     reasons.push("tech_stagnation_tier1"); 
   }
   // 🔥 НОВОЕ: Награда за здоровую конвертацию экономики в армию
   if (m.aiArmy > this.lastArmySize && m.resTotal < 150) { 
     penalty += 2.0; 
     reasons.push("healthy_economy_to_military_conversion"); 
   }  
   // 🔥 КРИТИЧЕСКИЙ ШТРАФ ЗА НАКОПИТЕЛЬСТВО (усилен)
   if (m.resTotal > 0.5 && m.aiArmy < 10) { 
     penalty -= 15.0; 
     reasons.push("CRITICAL_HOARDING: Богат (>1000 рес), но беззащитен!"); 
   }  
// 🔥 Штраф за склады без рабочих (ТОЛЬКО если есть ресурсы на найм)
const emptyWarehouses = gameState.buildings.filter(b =>
  b.owner === "ai" && b.type === "warehouse" && b.active && (b.workers || 0) === 0
).length;
if (emptyWarehouses > 0 && gameTimeMin > 1.0) {
  // 🔥 ПРОВЕРКА: хватает ли ресурсов на найм рабочих
  const canAffordWorkers = (m.res.gold || 0) >= (WORKER_COST.gold || 0) &&
                           (m.res.silicon || 0) >= (WORKER_COST.silicon || 0) &&
                           (m.res.plasma || 0) >= (WORKER_COST.plasma || 0);
  
  if (canAffordWorkers) {
    const emptyPenalty = -10.0 * emptyWarehouses;
    penalty += emptyPenalty;
    reasons.push(`EMPTY_WAREHOUSES: ${emptyWarehouses} складов простаивают без рабочих! (штраф ${emptyPenalty})`);
  } else {
    reasons.push(`EMPTY_WAREHOUSES_BUT_NO_RESOURCES: ${emptyWarehouses} складов без рабочих, но нет ресурсов на найм (штраф пропущен)`);
  }
}
   
   // 🔥 ШТРАФ ЗА КУЧКОВАНИЕ ЗДАНИЙ
   const aiBuildings = gameState.buildings.filter(b => b.owner === "ai" && b.health > 0);
   if (aiBuildings.length > 5) {
     let totalDist = 0;
     let pairCount = 0;
     for (let i = 0; i < Math.min(aiBuildings.length, 10); i++) {
       for (let j = i + 1; j < Math.min(aiBuildings.length, 10); j++) {
         totalDist += Math.hypot(aiBuildings[i].x - aiBuildings[j].x, aiBuildings[i].y - aiBuildings[j].y);
         pairCount++;
       }
     }
     const avgDist = pairCount > 0 ? totalDist / pairCount : 0;
     
     if (avgDist < 150) {
       const clusteringPenalty = -150.0 * (1 - avgDist / 150);
       penalty += clusteringPenalty;
       reasons.push(`CLUSTERING_PENALTY: Здания слишком близко друг к другу (среднее ${avgDist.toFixed(0)}px, штраф ${clusteringPenalty.toFixed(1)})`);
     }
   }
   // 🔥 НОВОЕ: Штраф за "оборонительную пассивность" (много турелей, мало атак)
   if (turretCount >= 3 && completedAttacks < 2 && gameTimeMin > 4) {
     const passivityPenalty = -10.0 * (turretCount - 2);
     penalty += passivityPenalty;
     reasons.push(`DEFENSIVE_PASSIVITY: ${turretCount} турелей, но только ${completedAttacks} атак (штраф ${passivityPenalty.toFixed(1)})`);
   }
   if (penalty !== 0) {
     const currentState = this.buildGraphState();
     if (currentState) {
       this.replay.push({ 
         X: currentState.X, 
         A_distance: currentState.A_distance, 
         A_threat: currentState.A_threat, 
         actionIndex: AIDX.idle, 
         reward: penalty 
       });
       if (penalty < 0) {
         console.warn(`[GnnAI] ⚠️ Обнаружен тупик: ${penalty.toFixed(1)} (${reasons.join(', ')})`);
       } else {
         console.log(`[GnnAI] ✅ Стагнация: +${penalty.toFixed(1)} (${reasons.join(', ')})`);
       }
     }
   }  
   const beaconsCount = gameState.buildings.filter(b => b.owner === "ai" && b.type === "beacon" && b.health > 0).length;
   if (beaconsCount >= 2 && m.aiArmy < 3 && m.enemyNear > 0) {
     penalty -= 15.0;
     reasons.push("FOOLISH_EXPANSION: Построен маяк, но нечем его защитить от врага!");
   }
   // 🔥 Регулярный штраф за долгое бездействие с ресурсами
   const gameTimeMin2 = performance.now() / 60000;
   const idleActionCount = (this.episodeReport?.actions?.idle || 0);
   if (idleActionCount > 10 && m.resTotal > 0.2 && gameTimeMin2 > 3) {
     const idlePenalty = -3.0 * Math.min(5, Math.floor(idleActionCount / 10));
     penalty += idlePenalty;
     reasons.push(`IDLE_SPAM: ${idleActionCount} бездействий при ресурсах ${m.resTotal.toFixed(2)} (штраф ${idlePenalty.toFixed(1)})`);
   }
   
   this.lastArmySize = m.aiArmy;
   this.lastBuildingCount = m.aiBuildings;
   this.lastResourceTotal = m.resTotal;
},
	  
	 evaluateEconomyEfficiency: function (now) {
      if (!this.lastEcoEffCheck || now - this.lastEcoEffCheck < 6000) return;
      this.lastEcoEffCheck = now;
      const m = this.metrics();
      const gameTimeMin = performance.now() / 60000;
      let reward = 0;
      let reasons = [];
      const buildingCount = m.aiBuildings;
      const armyValue = gameState.units
        .filter(u => u.owner === "ai" && ["fighter","assault","elite"].includes(u.type) && u.health > 0)
        .reduce((s, u) => s + this.getUnitValue(u.type), 0);
      const techScore = m.techLevel * 100;
      // Сила на одно здание
      const powerPerBuilding = (armyValue + techScore) / Math.max(1, buildingCount);
      // 1. Штраф за раздутую инфраструктуру (много зданий, мало силы на здание)
      if (gameTimeMin > 3 && buildingCount > 14 && powerPerBuilding < 30) {
        reward -= 12.0;
        reasons.push(`BLOATED_INFRASTRUCTURE: ${buildingCount} зданий, сила/здание=${powerPerBuilding.toFixed(0)} < 30. Меньше зданий, больше армии!`);
      }
      // 2. Бонус за конвертацию зданий в силу (здания не растут, а армия/тех растёт)
      if (this.lastBuildingCount > 0 && buildingCount <= this.lastBuildingCount) {
        const armyGrew = m.aiArmy > this.lastArmySize;
        const techGrew = m.techLevel > (this.lastTechLevel || 1);
        if (armyGrew || techGrew) {
          reward += 10.0;
          reasons.push(`EFFICIENT_CONVERSION: зданий ${buildingCount} (не +), но армия/тех выросли (+10)`);
        }
      }
      // 3. Штраф за маяки сверх нужного (усиленный)
      const beaconCount = gameState.buildings.filter(b =>
        b.owner === "ai" && b.type ==="beacon" && b.active
      ).length;
      if (beaconCount > 2) {
        const excess = beaconCount - 2;
        reward -= 8.0 * excess; // 🔥 Было -4.0*(N-4), стало -8.0*(N-2)
        reasons.push(`BEACON_OVERBUILD: ${beaconCount} маяков, штраф -${(8.0 * excess).toFixed(0)} (лишние после 2-го)`);
      }
      this.lastTechLevel = m.techLevel;

      if (reward !== 0) {
        const currentState = this.buildGraphState();
        if (currentState) {
          this.replay.push({ X: currentState.X, A_distance: currentState.A_distance, A_threat: currentState.A_threat, actionIndex: AIDX.idle, reward });
          if (reward < 0) console.warn(`[GnnAI] 💸 Неэффективная экономика: ${reward} (${reasons.join(', ')})`);
          else console.log(`[GnnAI] ✅ Экономия ресурсов: +${reward} (${reasons.join(', ')})`);
        }
      }
    },

    // ==========================================
// 🔥 НОВАЯ ФУНКЦИЯ: ОЦЕНКА КОНТРОЛЯ РЕСУРСОВ
// ==========================================
evaluateResourceControl: function (now) {
  if (!this.lastResourceControlCheck || now - this.lastResourceControlCheck < 5000) return;
  this.lastResourceControlCheck = now;
  
  const m = this.metrics();
  const gameTimeMin = performance.now() / 60000;
  let reward = 0;
  let reasons = [];
  
  // 🔥 1. Считаем ВСЕ ресурсы на карте
  const allResources = gameState.resources.filter(r => r.amount > 0);
  if (allResources.length === 0) return;
  
  // 🔥 2. Считаем, какие ресурсы ПОКРЫТЫ нашими складами (в радиусе 320px)
  const myWarehouses = gameState.buildings.filter(b => 
    b.owner === "ai" && b.type === "warehouse" && b.active
  );
  
  let myCoveredResources = 0;
  let myCoveredValue = 0;
  let playerCoveredResources = 0;
  let playerCoveredValue = 0;
  let neutralResources = 0;
  let neutralValue = 0;
  
  const playerWarehouses = gameState.buildings.filter(b => 
    b.owner === "player" && b.type === "warehouse" && b.active
  );
  
  allResources.forEach(r => {
    const value = r.amount || 0;
    
    // Проверяем покрытие нашими складами
    const myCover = myWarehouses.some(w => Math.hypot(w.x - r.x, w.y - r.y) < 320);
    // Проверяем покрытие вражескими складами
    const playerCover = playerWarehouses.some(w => Math.hypot(w.x - r.x, w.y - r.y) < 320);
    
    if (myCover) {
      myCoveredResources++;
      myCoveredValue += value;
    } else if (playerCover) {
      playerCoveredResources++;
      playerCoveredValue += value;
    } else {
      neutralResources++;
      neutralValue += value;
    }
  });
  
  const totalValue = myCoveredValue + playerCoveredValue + neutralValue;
  const myShare = totalValue > 0 ? myCoveredValue / totalValue : 0;
  const playerShare = totalValue > 0 ? playerCoveredValue / totalValue : 0;
  
  // 🔥 3. НАГРАДА ЗА ДОЛЮ КОНТРОЛЯ (чем больше, тем лучше)
  if (myShare > 0.5) {
    // Доминируем в ресурсах — большая награда
    const dominanceReward = 15.0 * myShare;
    reward += dominanceReward;
    reasons.push(`RESOURCE_DOMINANCE: контролируем ${(myShare * 100).toFixed(0)}% ресурсов (+${dominanceReward.toFixed(1)})`);
  } else if (myShare > 0.3) {
    // Хороший контроль — средняя награда
    reward += 8.0;
    reasons.push(`GOOD_RESOURCE_CONTROL: контролируем ${(myShare * 100).toFixed(0)}% ресурсов`);
  } else if (myShare > 0.15) {
    // Слабый контроль — небольшая награда
    reward += 3.0;
    reasons.push(`WEAK_RESOURCE_CONTROL: только ${(myShare * 100).toFixed(0)}% под контролем`);
  } else if (gameTimeMin > 3.0) {
    // 🔥 ШТРАФ: Почти нет контроля над ресурсами
    reward -= 10.0;
    reasons.push(`NO_RESOURCE_CONTROL: контролируем только ${(myShare * 100).toFixed(0)}% ресурсов! Строй склады!`);
  }
  
  // 🔥 4. ШТРАФ ЗА ОТСТАВАНИЕ ОТ ВРАГА ПО РЕСУРСАМ
  if (playerShare > myShare * 1.5 && gameTimeMin > 2.0) {
    const gapPenalty = -12.0 * (playerShare - myShare);
    reward += gapPenalty;
    reasons.push(`RESOURCE_GAP: враг контролирует ${(playerShare * 100).toFixed(0)}%, мы ${(myShare * 100).toFixed(0)}% (штраф ${gapPenalty.toFixed(1)})`);
  }
  
  // 🔥 5. НАГРАДА ЗА ЗАХВАТ НЕЙТРАЛЬНЫХ РЕСУРСОВ (те, что никто не контролирует)
  if (neutralValue > 0 && myWarehouses.length > 0) {
    // Проверяем, есть ли склады, которые МОГЛИ БЫ покрыть нейтральные ресурсы, но не покрывают
    const expandableResources = allResources.filter(r => {
      const myCover = myWarehouses.some(w => Math.hypot(w.x - r.x, w.y - r.y) < 320);
      const playerCover = playerWarehouses.some(w => Math.hypot(w.x - r.x, w.y - r.y) < 320);
      return !myCover && !playerCover && r.amount > 30;
    });
    
    if (expandableResources.length > 0 && myShare < 0.4 && gameTimeMin > 2.5) {
      // Есть ресурсы для захвата, но ИИ не расширяется
      reward -= 8.0;
      reasons.push(`MISSED_EXPANSION: ${expandableResources.length} нейтральных ресурсов (${neutralValue.toFixed(0)} ценности) не под контролем!`);
    }
  }
  
  // 🔥 6. БОНУС ЗА ЭФФЕКТИВНОСТЬ СКЛАДОВ (каждый склад работает на полную)
  const busyWarehouses = myWarehouses.filter(w => (w.workers || 0) >= (w.maxDeliveryWorkers || 5) * 0.6).length;
  if (busyWarehouses > 0 && myWarehouses.length > 0) {
    const efficiencyRatio = busyWarehouses / myWarehouses.length;
    if (efficiencyRatio > 0.7) {
      reward += 5.0;
      reasons.push(`WAREHOUSE_EFFICIENCY: ${(efficiencyRatio * 100).toFixed(0)}% складов загружены`);
    }
  }
  
  // 🔥 7. ШТРАФ ЗА ПОТЕРЮ ФОРПОСТА (если раньше был, а теперь нет)
  if (!this._lastOutpostCount) this._lastOutpostCount = 0;
  const currentOutposts = gameState.buildings.filter(b => 
    b.owner === "ai" && b.type === "beacon" && b.active &&
    gameState.buildings.some(o => 
      o.owner === "ai" && o !== b &&
      ["warehouse","turret","turret2","turret3"].includes(o.type) &&
      Math.hypot(o.x - b.x, o.y - b.y) < 300
    )
  ).length;
  
  if (currentOutposts < this._lastOutpostCount && gameTimeMin > 3.0) {
    const lostOutposts = this._lastOutpostCount - currentOutposts;
    const lossPenalty = -20.0 * lostOutposts;
    reward += lossPenalty;
    reasons.push(`OUTPOST_LOST: потеряли ${lostOutposts} форпостов! (штраф ${lossPenalty.toFixed(1)})`);
  }
  this._lastOutpostCount = currentOutposts;
  
  // 🔥 8. БОНУС ЗА УДЕРЖАНИЕ ФОРПОСТА ДОЛГОЕ ВРЕМЯ
  const stableOutposts = gameState.buildings.filter(b => 
    b.owner === "ai" && b.type === "beacon" && b.active && b.builtAt &&
    (performance.now() - b.builtAt) > 120000 && // 2+ минуты
    gameState.buildings.some(o => 
      o.owner === "ai" && o !== b &&
      ["warehouse","turret","turret2","turret3"].includes(o.type) &&
      Math.hypot(o.x - b.x, o.y - b.y) < 300
    )
  ).length;
  
  if (stableOutposts > 0) {
    const stabilityBonus = 5.0 * stableOutposts;
    reward += stabilityBonus;
    reasons.push(`STABLE_OUTPOSTS: ${stableOutposts} форпостов удерживаются 2+ мин (+${stabilityBonus.toFixed(1)})`);
  }
  
  // 🔥 ПРИМЕНЯЕМ НАГРАДУ
  if (reward !== 0) {
    const currentState = this.buildGraphState();
    if (currentState) {
      this.replay.push({ 
        X: currentState.X, 
        A_distance: currentState.A_distance, 
        A_threat: currentState.A_threat, 
        actionIndex: AIDX.idle, 
        reward 
      });
      if (reward > 0) {
        console.log(`[GnnAI] 💎 Контроль ресурсов: +${reward.toFixed(1)} (${reasons.join(', ')})`);
      } else {
        console.warn(`[GnnAI] ⚠️ Контроль ресурсов: ${reward.toFixed(1)} (${reasons.join(', ')})`);
      }
    }
  }
},
	  
    evaluateMilitaryBalance: function (now) {
      if (!this.lastMilitaryCheck || now - this.lastMilitaryCheck < 3000) return;
      this.lastMilitaryCheck = now;
      const m = this.metrics();
      let penalty = 0;
      let reasons = [];
      const myUnits = gameState.units.filter(u => u.owner === "ai" && u.health > 0);
      const enemyUnits = gameState.units.filter(u => u.owner === "player" && u.health > 0);
      let myPower = 0;
      myUnits.forEach(u => { myPower += u.health + (this.getUnitDps(u.type) * 10); });
      let enemyPower = 0;
      enemyUnits.forEach(u => { enemyPower += u.health + (this.getUnitDps(u.type) * 10); });
      const turretCount = gameState.buildings.filter(b => b.owner === "ai" && b.type?.startsWith("turret") && b.health > 0).length;
      const myDefensePower = turretCount * 150; 
      const totalMyStrength = myPower + myDefensePower;

      if (enemyPower > 0) {
        if (totalMyStrength < enemyPower * 0.5) { penalty -= 10.0; reasons.push("CRITICAL_WEAK_DEFENSE: Враг в 2 раза сильнее!"); } 
        else if (totalMyStrength > enemyPower * 1.5) { penalty += 5.0; reasons.push("STRONG_DEFENSE: Превосходство в силе!"); }
      }
      if (m.enemyNear > 0 && m.baseHp > 0.95 && turretCount > 0) { penalty += 3.0; reasons.push("EFFECTIVE_DEFENSE: База цела под огнем!"); }
      if (penalty !== 0) {
        const currentState = this.buildGraphState();
        if (currentState) {
          this.replay.push({ X: currentState.X, A_distance: currentState.A_distance, A_threat: currentState.A_threat, actionIndex: AIDX.idle, reward: penalty });
          if (penalty < 0) console.warn(`[GnnAI] ⚠️ Дисбаланс сил: ${penalty} (${reasons.join(', ')})`);
        }
      }
    },

    evaluateOpponentGap: function (now) {
      if (!this.lastGapCheck || now - this.lastGapCheck < 3000) return;
      this.lastGapCheck = now;
      const m = this.metrics();
      const gameTimeMin = performance.now() / 60000;
      let penalty = 0;
      let reasons = [];
      const enemyWorkers = gameState.units.filter(u => u.owner === "player" && u.type ==="worker" && u.health > 0).length;
      const myWorkers = gameState.units.filter(u => u.owner === "ai" && u.type ==="worker" && u.health > 0).length;
      
      if (gameTimeMin > 1.5 && myWorkers < enemyWorkers - 2) {
        penalty -= 15.0;
        reasons.push(`ECONOMIC_LAG: У врага ${enemyWorkers} рабочих, у нас ${myWorkers}. Срочно строить склады!`);
      }
      const enemyArmyValue = gameState.units.filter(u => u.owner === "player" && u.health > 0).reduce((sum, u) => sum + this.getUnitValue(u.type), 0);
      const myArmyValue = m.aiArmy * 30; 

      if (gameTimeMin > 2.0 && enemyArmyValue > myArmyValue + 150) {
        penalty -= 20.0;
        reasons.push("MILITARY_LAG: Враг превосходит в силе! Нужна срочная мобилизация или турели!");
      }
      const enemyHasBase2 = gameState.buildings.some(b => b.owner === "player" && b.type ==="base2");
      const myHasBase2 = gameState.buildings.some(b => b.owner === "ai" && b.type ==="base2");
      
      if (gameTimeMin > 4.0 && enemyHasBase2 && !myHasBase2) {
        penalty -= 25.0;
        reasons.push("TECH_LAG: Враг перешел на Тир-2, а мы застряли! Нужно расширяться!");
      }
      if (penalty < 0) {
        const currentState = this.buildGraphState();
        if (currentState) {
          this.replay.push({ X: currentState.X, A_distance: currentState.A_distance, A_threat: currentState.A_threat, actionIndex: AIDX.idle, reward: penalty });
          console.warn(`[GnnAI] ⚠️ Отставание от противника: ${penalty} (${reasons.join(', ')})`);
        }
      }
    },

// 🔥 НОВАЯ ФУНКЦИЯ: ОЦЕНКА АКТИВНОСТИ АРМИИ
evaluateArmyActivity: function (now) {
  if (!this.lastArmyActivityCheck || now - this.lastArmyActivityCheck < 4000) return;
  this.lastArmyActivityCheck = now;
  
  const m = this.metrics();
  const gameTimeMin = performance.now() / 60000;
  let reward = 0;
  let reasons = [];
  
  // 🔥 1. Считаем боевые юниты ИИ
  const combatUnits = gameState.units.filter(u => 
    u.owner === "ai" && ["fighter", "assault", "elite"].includes(u.type) && u.health > 0
  );
  
  if (combatUnits.length === 0) return; // Нет армии — другие функции штрафуют
  
  // 🔥 2. Считаем, сколько юнитов ЗАДЕЙСТВОВАНЫ (имеют команду attack/move)
  let busyUnits = 0;
  let attackingUnits = 0;
  let defendingUnits = 0;
  let idleUnits = 0;
  
  combatUnits.forEach(u => {
    if (u.commandQueue && u.commandQueue.length > 0) {
      busyUnits++;
      const hasAttack = u.commandQueue.some(cmd => cmd.type === "attack");
      const hasMove = u.commandQueue.some(cmd => cmd.type === "move");
      if (hasAttack) attackingUnits++;
      else if (hasMove && u.defending) defendingUnits++;
    } else {
      idleUnits++;
    }
  });
  
  const busyRatio = busyUnits / combatUnits.length;
  const idleRatio = idleUnits / combatUnits.length;
  
  // 🔥 3. КРИТИЧЕСКИЙ ШТРАФ: Армия есть, но никто не воюет
  if (combatUnits.length >= 3 && idleRatio > 0.7 && gameTimeMin > 2.5) {
    const idlePenalty = -20.0 * idleRatio;
    reward += idlePenalty;
    reasons.push(`ARMY_IDLE_CRITICAL: ${idleUnits}/${combatUnits.length} бойцов без команд (${idlePenalty.toFixed(1)})`);
  }
  else if (combatUnits.length >= 2 && idleRatio > 0.5 && gameTimeMin > 2.0) {
    const idlePenalty = -10.0 * idleRatio;
    reward += idlePenalty;
    reasons.push(`ARMY_IDLE: ${idleUnits}/${combatUnits.length} бойцов без команд (${idlePenalty.toFixed(1)})`);
  }
  
  // 🔥 4. ШТРАФ ЗА "ПАРОД" (армия сидит у базы, враг не атакует)
  if (idleUnits >= 3 && m.enemyNear === 0 && gameTimeMin > 3.0) {
    let baseCampingCount = 0;
    combatUnits.forEach(u => {
      const distToBase = Math.hypot(u.x - aiBase.x, u.y - aiBase.y);
      if (distToBase < 300) baseCampingCount++;
    });
    
    if (baseCampingCount >= 3) {
      const campingPenalty = -15.0;
      reward += campingPenalty;
      reasons.push(`ARMY_CAMPING: ${baseCampingCount} бойцов сидят у базы без причины (${campingPenalty})`);
    }
  }
  
  // 🔥 5. НАГРАДА ЗА АКТИВНЫЕ АТАКИ (армия реально воюет)
  if (attackingUnits >= 2) {
    const attackBonus = Math.min(15.0, attackingUnits * 3.0);
    reward += attackBonus;
    reasons.push(`ARMY_ATTACKING: ${attackingUnits} бойцов в атаке (+${attackBonus.toFixed(1)})`);
  }
  
  // 🔥 6. НАГРАДА ЗА АКТИВНУЮ ОБОРОНУ (армия защищает)
  if (defendingUnits >= 2 && m.enemyNear > 0) {
    const defenseBonus = Math.min(10.0, defendingUnits * 2.0);
    reward += defenseBonus;
    reasons.push(`ARMY_DEFENDING: ${defendingUnits} бойцов защищают (+${defenseBonus.toFixed(1)})`);
  }
  
  // 🔥 7. ШТРАФ ЗА "АРМИЯ БЕЗ ЦЕЛИ" (есть армия, но нет активных миссий)
  const activeMissions = this.missionCache.filter(m => 
    !m.resolved && (m.intent.type === "attack" || m.intent.type === "defend")
  ).length;
  
  if (combatUnits.length >= 3 && activeMissions === 0 && gameTimeMin > 3.0) {
    const noMissionPenalty = -12.0;
    reward += noMissionPenalty;
    reasons.push(`ARMY_NO_MISSION: ${combatUnits.length} бойцов, но НЕТ активных миссий (${noMissionPenalty})`);
  }
  
  // 🔥 8. БОНУС ЗА РАЗНООБРАЗИЕ ЗАДАЧ (атака + защита одновременно)
  if (attackingUnits > 0 && defendingUnits > 0) {
    reward += 8.0;
    reasons.push(`ARMY_DIVERSITY: армия разделена на атаку (${attackingUnits}) и защиту (${defendingUnits})`);
  }
  
  // 🔥 9. ШТРАФ ЗА "АРМИЯ БЕЗ ДВИЖЕНИЯ" (юниты стоят на месте долго)
  if (!this._lastArmyPositions) this._lastArmyPositions = new Map();
  let stuckUnits = 0;
  
  combatUnits.forEach(u => {
    const lastPos = this._lastArmyPositions.get(u.id);
    if (lastPos) {
      const moved = Math.hypot(u.x - lastPos.x, u.y - lastPos.y);
      if (moved < 5) stuckUnits++; // Стоит на месте (< 5px за 4 секунды)
    }
    this._lastArmyPositions.set(u.id, { x: u.x, y: u.y });
  });
  
  if (stuckUnits >= 3 && stuckUnits > combatUnits.length * 0.5 && gameTimeMin > 2.5) {
    const stuckPenalty = -8.0;
    reward += stuckPenalty;
    reasons.push(`ARMY_STUCK: ${stuckUnits}/${combatUnits.length} бойцов стоят на месте (${stuckPenalty})`);
  }
  
  // 🔥 ПРИМЕНЯЕМ НАГРАДУ
  if (reward !== 0) {
    const currentState = this.buildGraphState();
    if (currentState) {
      this.replay.push({ 
        X: currentState.X, 
        A_distance: currentState.A_distance, 
        A_threat: currentState.A_threat, 
        actionIndex: AIDX.idle, 
        reward 
      });
      if (reward > 0) {
        console.log(`[GnnAI] ⚔️ Активность армии: +${reward.toFixed(1)} (${reasons.join(', ')})`);
      } else {
        console.warn(`[GnnAI] ⚠️ Активность армии: ${reward.toFixed(1)} (${reasons.join(', ')})`);
      }
    }
  }
},

// 🔥 НОВАЯ ФУНКЦИЯ: ОЦЕНКА ЭФФЕКТИВНОСТИ БОЯ
evaluateCombatEfficiency: function (now) {
  if (!this.lastCombatEfficiencyCheck || now - this.lastCombatEfficiencyCheck < 6000) return;
  this.lastCombatEfficiencyCheck = now;
  
  const m = this.metrics();
  const gameTimeMin = performance.now() / 60000;
  let reward = 0;
  let reasons = [];
  
  // 🔥 1. Считаем ВСЕ юниты ИИ (живые и мертвые за последний период)
  const myCombatUnits = gameState.units.filter(u => 
    u.owner === "ai" && ["fighter", "assault", "elite"].includes(u.type)
  );
  
  const aliveMyUnits = myCombatUnits.filter(u => u.health > 0);
  const deadMyUnits = myCombatUnits.filter(u => u.health <= 0);
  
  // 🔥 2. Считаем юнитов противника
  const enemyCombatUnits = gameState.units.filter(u => 
    u.owner === "player" && ["fighter", "assault", "elite"].includes(u.type)
  );
  const aliveEnemyUnits = enemyCombatUnits.filter(u => u.health > 0);
  
  // 🔥 3. Считаем текущий урон через missionLog (суммарный по всем активным миссиям)
  let currentDamageDealt = 0;
  let currentDamageTaken = 0;
  let killedEnemies = 0;
  let lostAllies = 0;
  
  // Считаем по активным миссиям
  this.missionCache.forEach(mission => {
    if (mission.resolved || mission.intent.type !== "attack") return;
    const unitIds = mission.intent.unitIds || [];
    unitIds.forEach(id => {
      const u = gameState.units.find(x => x.id === id);
      if (u && u.missionLog) {
        currentDamageDealt += u.missionLog.damageDealt || 0;
        currentDamageTaken += u.missionLog.damageTaken || 0;
        if (!u.missionLog.alive) lostAllies++;
        // Считаем убитых врагов по событиям
        const killEvents = (u.missionLog.events || []).filter(e => 
          e.type === "target_destroyed" && e.to && e.to.owner === "player"
        );
        killedEnemies += killEvents.length;
      }
    });
  });
  
  // 🔥 4. Считаем ДЕЛЬТУ с прошлой проверки (чтобы не награждать повторно)
  const deltaDamageDealt = currentDamageDealt - (this._lastDamageDealt || 0);
  const deltaDamageTaken = currentDamageTaken - (this._lastDamageTaken || 0);
  const deltaKills = killedEnemies - (this._lastKillCount || 0);
  const deltaDeaths = lostAllies - (this._lastDeathCount || 0);
  
  // Обновляем счётчики
  this._lastDamageDealt = currentDamageDealt;
  this._lastDamageTaken = currentDamageTaken;
  this._lastKillCount = killedEnemies;
  this._lastDeathCount = lostAllies;
  
  // 🔥 5. ОЦЕНКА KILL/DEATH RATIO
  if (deltaDeaths > 0 || deltaKills > 0) {
    const kdRatio = deltaKills / Math.max(1, deltaDeaths);
    
    if (kdRatio >= 2.0 && deltaKills >= 2) {
      // 🔥 ОТЛИЧНЫЙ ОБМЕН: убили в 2+ раза больше, чем потеряли
      const kdBonus = Math.min(25.0, kdRatio * 8.0 + deltaKills * 3.0);
      reward += kdBonus;
      reasons.push(`EXCELLENT_KD: убито ${deltaKills}, потеряно ${deltaDeaths} (K/D=${kdRatio.toFixed(2)}, +${kdBonus.toFixed(1)})`);
    }
    else if (kdRatio >= 1.0 && deltaKills >= 1) {
      // Хороший обмен
      reward += 8.0;
      reasons.push(`GOOD_KD: убито ${deltaKills}, потеряно ${deltaDeaths} (K/D=${kdRatio.toFixed(2)})`);
    }
    else if (kdRatio < 0.5 && deltaDeaths >= 2) {
      // 🔥 ПЛОХОЙ ОБМЕН: потеряли больше, чем убили
      const kdPenalty = -12.0 * (1 - kdRatio) * Math.min(3, deltaDeaths);
      reward += kdPenalty;
      reasons.push(`BAD_KD: убито ${deltaKills}, потеряно ${deltaDeaths} (K/D=${kdRatio.toFixed(2)}, ${kdPenalty.toFixed(1)})`);
    }
  }
  
  // 🔥 6. ШТРАФ ЗА ПОТЕРИ БЕЗ УРОНА (армия погибла, не нанеся урона)
  if (deltaDeaths >= 2 && deltaDamageDealt < 20 && gameTimeMin > 2.0) {
    const wastePenalty = -15.0 * deltaDeaths;
    reward += wastePenalty;
    reasons.push(`WASTED_UNITS: ${deltaDeaths} юнитов погибло, урон только ${deltaDamageDealt.toFixed(0)} (${wastePenalty.toFixed(1)})`);
  }
  
  // 🔥 7. БОНУС ЗА ЭФФЕКТИВНОСТЬ УРОНА (урон/потери)
  if (deltaDamageDealt > 50 && deltaDamageTaken > 0) {
    const damageEfficiency = deltaDamageDealt / deltaDamageTaken;
    if (damageEfficiency > 2.0) {
      const effBonus = Math.min(15.0, damageEfficiency * 5.0);
      reward += effBonus;
      reasons.push(`DAMAGE_EFFICIENT: нанесли ${deltaDamageDealt.toFixed(0)} урона, получили ${deltaDamageTaken.toFixed(0)} (эффективность ${damageEfficiency.toFixed(1)}x, +${effBonus.toFixed(1)})`);
    }
  }
  
  // 🔥 8. ШТРАФ ЗА НЕЭФФЕКТИВНЫЙ УРОН (получили больше, чем нанесли)
  if (deltaDamageTaken > 100 && deltaDamageDealt < deltaDamageTaken * 0.5) {
    const ineffPenalty = -10.0;
    reward += ineffPenalty;
    reasons.push(`DAMAGE_INEFFICIENT: получили ${deltaDamageTaken.toFixed(0)} урона, нанесли только ${deltaDamageDealt.toFixed(0)} (${ineffPenalty})`);
  }
  
  // 🔥 9. БОНУС ЗА СОХРАНЕНИЕ АРМИИ (здоровая армия = сила)
  if (aliveMyUnits.length >= 3 && gameTimeMin > 3.0) {
    const healthyUnits = aliveMyUnits.filter(u => u.health > u.maxHealth * 0.7).length;
    const healthRatio = healthyUnits / aliveMyUnits.length;
    
    if (healthRatio >= 0.8) {
      const healthBonus = 5.0 + aliveMyUnits.length * 1.0;
      reward += healthBonus;
      reasons.push(`ARMY_HEALTHY: ${healthyUnits}/${aliveMyUnits.length} юнитов здоровы (+${healthBonus.toFixed(1)})`);
    }
  }
  
  // 🔥 10. ШТРАФ ЗА "МЯСНОЙ ШТИЛЬ" (армия вся раненая)
  if (aliveMyUnits.length >= 2 && gameTimeMin > 2.5) {
    const woundedUnits = aliveMyUnits.filter(u => u.health < u.maxHealth * 0.4).length;
    const woundedRatio = woundedUnits / aliveMyUnits.length;
    
    if (woundedRatio > 0.6) {
      const woundedPenalty = -12.0;
      reward += woundedPenalty;
      reasons.push(`ARMY_WOUNDED: ${woundedUnits}/${aliveMyUnits.length} юнитов при смерти (${woundedPenalty})`);
    }
  }
  
  // 🔥 11. БОНУС ЗА УНИЧТОЖЕНИЕ ВАЖНЫХ ЦЕЛЕЙ (через episodeReport)
  const recentKills = this.episodeReport?.timeline?.filter(e => 
    e.action === "strike_weak" || e.action === "focus_fire" || 
    e.action === "flank_attack" || e.action === "harass_economy"
  ).length || 0;
  
  // 🔥 12. ШТРАФ ЗА "АРМИЮ-ПРИЗРАК" (была армия, теперь нет, а враг жив)
  if (aliveMyUnits.length === 0 && aliveEnemyUnits.length > 0 && gameTimeMin > 2.0) {
    const ghostPenalty = -20.0;
    reward += ghostPenalty;
    reasons.push(`GHOST_ARMY: вся армия погибла, но враг ещё жив! (${ghostPenalty})`);
  }
  
  // 🔥 13. БОНУС ЗА ПРЕВОСХОДСТВО В СИЛЕ (наша армия больше вражеской)
  if (aliveMyUnits.length > aliveEnemyUnits.length * 1.5 && aliveMyUnits.length >= 3) {
    const superiorityBonus = 6.0;
    reward += superiorityBonus;
    reasons.push(`ARMY_SUPERIORITY: наша армия ${aliveMyUnits.length} vs враг ${aliveEnemyUnits.length} (+${superiorityBonus})`);
  }
  
  // 🔥 ПРИМЕНЯЕМ НАГРАДУ
  if (reward !== 0) {
    const currentState = this.buildGraphState();
    if (currentState) {
      this.replay.push({ 
        X: currentState.X, 
        A_distance: currentState.A_distance, 
        A_threat: currentState.A_threat, 
        actionIndex: AIDX.idle, 
        reward 
      });
      if (reward > 0) {
        console.log(`[GnnAI] ⚔️ Эффективность боя: +${reward.toFixed(1)} (${reasons.join(', ')})`);
      } else {
        console.warn(`[GnnAI] ⚠️ Эффективность боя: ${reward.toFixed(1)} (${reasons.join(', ')})`);
      }
    }
  }
},

// ==========================================
// 🔥 НОВАЯ ФУНКЦИЯ: ОЦЕНКА КАЧЕСТВА ВЫБОРА ЦЕЛЕЙ
// ==========================================
evaluateTargetSelection: function (now) {
  if (!this.lastTargetSelectionCheck || now - this.lastTargetSelectionCheck < 8000) return;
  this.lastTargetSelectionCheck = now;
  
  const m = this.metrics();
  const gameTimeMin = performance.now() / 60000;
  let reward = 0;
  let reasons = [];
  
  // 🔥 1. Анализируем последние завершённые атаки (из missionCache)
  const recentAttacks = this.missionCache.filter(m => 
    m.resolved && m.intent.type === "attack" && 
    (now - m.snapshot.time) < 30000 // Последние 30 секунд
  );
  
  if (recentAttacks.length === 0) return;
  
  let goodTargets = 0;
  let badTargets = 0;
  let isolatedTargets = 0;
  let turretProtectedTargets = 0;
  let totalDamageDealt = 0;
  let totalDamageTaken = 0;
  let totalLosses = 0;
  
  recentAttacks.forEach(mission => {
    const unitIds = mission.intent.unitIds || [];
    const targetId = mission.snapshot.targetId;
    const target = gameState.units.find(u => u.id === targetId) || 
                   gameState.buildings.find(b => b.id === targetId);
    
    if (!target) return;
    
    // 🔥 2. Оцениваем защищённость цели
    const enemyTurrets = gameState.buildings.filter(b => 
      b.owner === "player" && b.type?.startsWith("turret") && b.health > 0
    );
    
    const turretsNearTarget = enemyTurrets.filter(t => 
      Math.hypot(t.x - target.x, t.y - target.y) < 300
    ).length;
    
    // 🔥 3. Оцениваем изолированность цели
    const enemyUnits = gameState.units.filter(u => 
      u.owner === "player" && u.health > 0
    );
    const enemiesNearTarget = enemyUnits.filter(u => 
      Math.hypot(u.x - target.x, u.y - target.y) < 250
    ).length;
    
    const isIsolated = enemiesNearTarget === 0 && turretsNearTarget === 0;
    const isProtected = turretsNearTarget >= 2;
    
    // 🔥 4. Считаем урон и потери
    const logs = unitIds.map(id => {
      const u = gameState.units.find(x => x.id === id);
      return u ? u.missionLog : null;
    }).filter(Boolean);
    
    const damageDealt = logs.reduce((s, l) => s + (l.damageDealt || 0), 0);
    const damageTaken = logs.reduce((s, l) => s + (l.damageTaken || 0), 0);
    const losses = logs.filter(l => !l.alive).length;
    
    totalDamageDealt += damageDealt;
    totalDamageTaken += damageTaken;
    totalLosses += losses;
    
    // 🔥 5. Оцениваем качество выбора
    if (isIsolated && damageDealt > 50) {
      // Отличная цель: изолированная + нанесли урон
      goodTargets++;
      isolatedTargets++;
    } else if (isProtected && losses > 0) {
      // Плохая цель: защищённая + потери
      badTargets++;
      turretProtectedTargets++;
    } else if (damageDealt > 100 && losses === 0) {
      // Хорошая цель: большой урон без потерь
      goodTargets++;
    } else if (losses > 2 && damageDealt < 50) {
      // Плохая цель: большие потери, мало урона
      badTargets++;
    }
  });
  
  // 🔥 6. НАГРАДА ЗА ХОРОШИЕ ЦЕЛИ
  if (goodTargets > 0) {
    const goodBonus = Math.min(20.0, goodTargets * 8.0);
    reward += goodBonus;
    reasons.push(`GOOD_TARGETS: ${goodTargets} хорошо выбранных целей (+${goodBonus.toFixed(1)})`);
  }
  
  // 🔥 7. БОНУС ЗА ИЗОЛИРОВАННЫЕ ЦЕЛИ (harass)
  if (isolatedTargets > 0) {
    const isolatedBonus = Math.min(15.0, isolatedTargets * 6.0);
    reward += isolatedBonus;
    reasons.push(`ISOLATED_TARGETS: ${isolatedTargets} изолированных целей (+${isolatedBonus.toFixed(1)})`);
  }
  
  // 🔥 8. ШТРАФ ЗА ПЛОХИЕ ЦЕЛИ
  if (badTargets > 0) {
    const badPenalty = -12.0 * badTargets;
    reward += badPenalty;
    reasons.push(`BAD_TARGETS: ${badTargets} плохо выбранных целей (${badPenalty.toFixed(1)})`);
  }
  
  // 🔥 9. ШТРАФ ЗА АТАКУ ПОД ТУРЕЛЯМИ
  if (turretProtectedTargets > 0 && totalLosses > 0) {
    const turretPenalty = -15.0 * turretProtectedTargets;
    reward += turretPenalty;
    reasons.push(`TURRET_TRAP: ${turretProtectedTargets} атак под турелями с потерями (${turretPenalty.toFixed(1)})`);
  }
  
  // 🔥 10. БОНУС ЗА ЭФФЕКТИВНОСТЬ (урон/потери)
  if (totalDamageDealt > 100 && totalDamageTaken > 0) {
    const efficiency = totalDamageDealt / totalDamageTaken;
    if (efficiency > 2.5) {
      const effBonus = Math.min(12.0, efficiency * 3.0);
      reward += effBonus;
      reasons.push(`TARGET_EFFICIENCY: урон/потери = ${efficiency.toFixed(1)}x (+${effBonus.toFixed(1)})`);
    }
  }
  
  // 🔥 11. ШТРАФ ЗА НЕЭФФЕКТИВНОСТЬ
  if (totalLosses > 3 && totalDamageDealt < 100) {
    const ineffPenalty = -10.0;
    reward += ineffPenalty;
    reasons.push(`TARGET_INEFFICIENT: ${totalLosses} потерь, но урон только ${totalDamageDealt.toFixed(0)} (${ineffPenalty})`);
  }
  
  // 🔥 12. БОНУС ЗА РАЗНООБРАЗИЕ ЦЕЛЕЙ (не спамить одну и ту же)
  const uniqueTargets = new Set(recentAttacks.map(m => m.snapshot.targetId)).size;
  if (uniqueTargets >= 3 && recentAttacks.length >= 3) {
    reward += 8.0;
    reasons.push(`TARGET_DIVERSITY: атаковано ${uniqueTargets} разных целей (+8)`);
  }
  
  // 🔥 13. ШТРАФ ЗА СПАМ ОДНОЙ ЦЕЛИ (если атаковали одну цель 3+ раза)
  const targetCounts = {};
  recentAttacks.forEach(m => {
    const id = m.snapshot.targetId;
    targetCounts[id] = (targetCounts[id] || 0) + 1;
  });
  const maxSameTarget = Math.max(...Object.values(targetCounts));
  if (maxSameTarget >= 3 && recentAttacks.length >= 4) {
    const spamPenalty = -8.0;
    reward += spamPenalty;
    reasons.push(`TARGET_SPAM: одна цель атакована ${maxSameTarget} раз (${spamPenalty})`);
  }
  
  // 🔥 ПРИМЕНЯЕМ НАГРАДУ
  if (reward !== 0) {
    const currentState = this.buildGraphState();
    if (currentState) {
      this.replay.push({ 
        X: currentState.X, 
        A_distance: currentState.A_distance, 
        A_threat: currentState.A_threat, 
        actionIndex: AIDX.idle, 
        reward 
      });
      if (reward > 0) {
        console.log(`[GnnAI] 🎯 Выбор целей: +${reward.toFixed(1)} (${reasons.join(', ')})`);
      } else {
        console.warn(`[GnnAI] ⚠️ Выбор целей: ${reward.toFixed(1)} (${reasons.join(', ')})`);
      }
    }
  }
},

// 🔥 ОЦЕНКА РАЗВЕДКИ ТЕРРИТОРИИ ЮНИТАМИ — ИСПРАВЛЕННАЯ ВЕРСИЯ
evaluateRecon: function (now) {
  if (!this.lastReconCheck || now - this.lastReconCheck < 3000) return;
  this.lastReconCheck = now;
  const m = this.metrics();
  const gameTimeMin = performance.now() / 60000;
  let reward = 0;
  let reasons = [];
  
  // 🔥 КЛЮЧЕВОЕ ИСПРАВЛЕНИЕ: Награда только за РЕАЛЬНУЮ разведку (обнаружение врагов)
  // Считаем, сколько НОВЫХ вражеских объектов мы обнаружили в радиусе зрения юнитов
  const combatUnits = gameState.units.filter(u =>
    u.owner === "ai" && ["fighter", "assault", "elite"].includes(u.type) && u.health > 0
  );
  
  // 🔥 Считаем реальную пользу: сколько врагов видели наши разведчики за последние 3 секунды
  let newEnemySightings = 0;
  let importantEnemySightings = 0;
  const visionRadius = 300; // радиус зрения боевого юнита
  
  combatUnits.forEach(u => {
    const enemiesNear = gameState.units.filter(e => 
      e.owner === "player" && e.health > 0 && 
      Math.hypot(e.x - u.x, e.y - u.y) < visionRadius
    );
    newEnemySightings += enemiesNear.length;
    
    // Важные цели (базы, склады, турели) дают больше пользы
    const importantNear = enemiesNear.filter(e => 
      ["base","base2","base3","warehouse","barracks","turret","turret2","turret3"].includes(e.type)
    );
    importantEnemySightings += importantNear.length;
  });
  
  // 🔥 НАГРАДА ТОЛЬКО ЗА РЕАЛЬНУЮ РАЗВЕДКУ
  if (importantEnemySightings > 0) {
    // Обнаружили важную цель — большая награда
    reward += Math.min(20.0, importantEnemySightings * 8.0);
    reasons.push(`INTEL_FOUND: обнаружено ${importantEnemySightings} важных целей`);
  } else if (newEnemySightings > 0) {
    // Обнаружили обычных врагов — малая награда
    reward += Math.min(10.0, newEnemySightings * 3.0);
    reasons.push(`INTEL_FOUND: обнаружено ${newEnemySightings} врагов`);
  } else if (combatUnits.length > 0) {
    // 🔥 ШТРАФ ЗА "ОРБИТАЛЬНУЮ РАЗВЕДКУ": юниты далеко, но ничего не видят
    let maxDist = 0;
    combatUnits.forEach(u => {
      const d = Math.hypot(u.x - aiBase.x, u.y - aiBase.y);
      if (d > maxDist) maxDist = d;
    });
    
    if (maxDist > 500) {
      // Юниты далеко, но ничего не видят = бесполезная разведка
      const orbitPenalty = -8.0 * (maxDist / 500);
      reward += orbitPenalty;
      reasons.push(`ORBITAL_RECON_PENALTY: юниты на ${maxDist.toFixed(0)}px, но ничего не видят (${orbitPenalty.toFixed(1)})`);
    } else if (maxDist > 300) {
      // Небольшой штраф за "полураскрытие"
      reward -= 3.0;
      reasons.push(`WEAK_RECON: юниты на ${maxDist.toFixed(0)}px, ничего не видят`);
    } else {
      // Юниты близко к базе — это нормально, если есть враги рядом
      if (m.enemyNear > 0) {
        reward += 2.0;
        reasons.push(`LOCAL_DEFENSE_RECON: юниты рядом с базой, враги обнаружены`);
      }
    }
  }
  
  // 🔥 ШТРАФ ЗА СИДЕНИЕ У БАЗЫ (когда враг далеко)
  if (combatUnits.length > 0) {
    let totalDist = 0;
    combatUnits.forEach(u => {
      totalDist += Math.hypot(u.x - aiBase.x, u.y - aiBase.y);
    });
    const avgDist = totalDist / combatUnits.length;
    
    if (gameTimeMin > 2.0 && avgDist < 200 && combatUnits.length >= 3 && m.enemyNear === 0) {
      const campPenalty = -10.0;
      reward += campPenalty;
      reasons.push(`BASE_CAMPING: ${combatUnits.length} юнитов сидят у базы без причины`);
    }
  }
  
  // 🔥 ШТРАФ ЗА ОДНО НАПРАВЛЕНИЕ (но только если юнитов много)
  if (combatUnits.length >= 3) {
    const directions = new Set();
    combatUnits.forEach(u => {
      const angle = Math.atan2(u.y - aiBase.y, u.x - aiBase.x);
      const sector = Math.floor((angle + Math.PI) / (Math.PI / 2));
      directions.add(sector);
    });
    
    if (directions.size === 1) {
      reward -= 5.0;
      reasons.push(`SINGLE_DIRECTION: все ${combatUnits.length} юнитов в одном направлении`);
    } else if (directions.size >= 3) {
      // 🔥 ИСПРАВЛЕНИЕ: Награда за направления ТОЛЬКО если они что-то видят
      if (newEnemySightings > 0 || importantEnemySightings > 0) {
        reward += 5.0;
        reasons.push(`MULTI_DIRECTION_INTEL: разведка в ${directions.size} направлениях с обнаружением врагов`);
      }
      // Если ничего не видят — не награждаем (убрали +10)
    }
  }
  
  // 🔥 ШТРАФ ЗА ДОЛГОЕ ОТСУТСТВИЕ РАЗВЕДКИ
  if (gameTimeMin > 3.0 && combatUnits.length === 0) {
    reward -= 8.0;
    reasons.push(`NO_RECON_FOR_LONG_TIME: ${gameTimeMin.toFixed(1)} мин без разведки`);
  }
  
  // 🔥 ШТРАФ ЗА НЕТ БОЕВЫХ ЮНИТОВ ВООБЩЕ
  if (gameTimeMin > 2.0 && m.aiArmy === 0) {
    reward -= 5.0;
    reasons.push("NO_ARMY_FOR_RECON: нет боевых юнитов");
  }
  
  // Применяем награду
  if (reward !== 0) {
    const currentState = this.buildGraphState();
    if (currentState) {
      this.replay.push({
        X: currentState.X,
        A_distance: currentState.A_distance,
        A_threat: currentState.A_threat,
        actionIndex: AIDX.idle,
        reward
      });
      if (reward > 0) {
        console.log(`[GnnAI] 🛰️ Разведка: +${reward.toFixed(1)} (${reasons.join(', ')})`);
      } else {
        console.warn(`[GnnAI] ⚠️ Разведка: ${reward.toFixed(1)} (${reasons.join(', ')})`);
      }
    }
  }
},

// ==========================================
// 🔥 ОЦЕНКА ЭКСПАНСИИ И ФОРПОСТОВ
// ==========================================
evaluateExpansion: function (now) {
  if (!this.lastExpansionCheck || now - this.lastExpansionCheck < 5000) return;
  this.lastExpansionCheck = now;
  
  const m = this.metrics();
  const gameTimeMin = performance.now() / 60000;
  let reward = 0;
  let reasons = [];
  
  // 1. Находим все здания ИИ и группируем их по кластерам
  const aiBuildings = gameState.buildings.filter(b => 
    b.owner === "ai" && b.health > 0 && b.type !== "base"
  );
  
  if (aiBuildings.length === 0) {
    if (gameTimeMin > 2.0) {
      reward -= 10.0;
      reasons.push("NO_EXPANSION: нет зданий за пределами базы");
    }
    if (reward !== 0) {
      const currentState = this.buildGraphState();
      if (currentState) {
        this.replay.push({ 
          X: currentState.X, 
          A_distance: currentState.A_distance, 
          A_threat: currentState.A_threat, 
          actionIndex: AIDX.idle, 
          reward 
        });
        console.warn(`[GnnAI] 🏗️ Экспансия: ${reward.toFixed(1)} (${reasons.join(', ')})`);
      }
    }
    return;
  }
  
  // 2. Ищем полноценные форпосты (маяк + турель + склад + мастерская в радиусе 300px)
  const outposts = [];
  const beacons = aiBuildings.filter(b => b.type === "beacon");
  
  beacons.forEach(beacon => {
    const nearby = aiBuildings.filter(b => 
      Math.hypot(b.x - beacon.x, b.y - beacon.y) < 300
    );
    
    const hasTurret = nearby.some(b => b.type.startsWith("turret"));
    const hasWarehouse = nearby.some(b => b.type === "warehouse");
    const hasWorkshop = nearby.some(b => b.type === "repairWorkshop");
    const hasBarracks = nearby.some(b => b.type.startsWith("barracks"));
    
    const score = (hasTurret ? 1 : 0) + (hasWarehouse ? 1 : 0) + 
                  (hasWorkshop ? 1 : 0) + (hasBarracks ? 1 : 0);
    
    if (score >= 3) {
      outposts.push({ beacon, score, buildings: nearby });
    }
  });
  
// 🔥 3. НАГРАДЫ ЗА ФОРПОСТЫ — ИСПРАВЛЕННАЯ ВЕРСИЯ
if (outposts.length > 0) {
  // Первый форпост = +25, второй = +20, третий = +15, четвёртый+ = +10
  let outpostReward = 0;
  for (let i = 0; i < outposts.length; i++) {
    if (i === 0) outpostReward += 25.0;
    else if (i === 1) outpostReward += 20.0;
    else if (i === 2) outpostReward += 15.0;
    else outpostReward += 10.0;
  }
  reward += outpostReward;
  reasons.push(`OUTPOSTS_BUILT: ${outposts.length} полноценных форпостов (+${outpostReward.toFixed(1)}, убывающая ценность)`);
  
  // 🔥 НОВОЕ: Штраф за отсутствие прогресса в экспансии (если форпостов мало)
  if (outposts.length === 1 && gameTimeMin > 5.0) {
    reward -= 10.0;
    reasons.push("STAGNANT_EXPANSION: только 1 форпост после 5 минут!");
  } else if (outposts.length === 0 && gameTimeMin > 3.0 && m.resTotal > 0.3) {
    reward -= 15.0;
    reasons.push("NO_OUTPOSTS: нет форпостов после 3 минут при ресурсах > 600!");
  }
  
  // 🔥 ИСПРАВЛЕНИЕ: Награда за дальние форпосты только если они УСТОЙЧИВЫЕ
  outposts.forEach(op => {
    const dist = Math.hypot(op.beacon.x - aiBase.x, op.beacon.y - aiBase.y);
    
    // 🔥 НОВОЕ: Проверяем, что форпост защищён (есть турели)
    const hasDefense = op.buildings.some(b => b.type.startsWith("turret"));
    const hasEconomy = op.buildings.some(b => b.type === "warehouse");
    
    if (dist > 500) {
      if (hasDefense && hasEconomy) {
        // Дальний форпост с защитой и экономикой — большая награда
        reward += 20.0;
        reasons.push(`DEEP_SECURED_OUTPOST: форпост на ${dist.toFixed(0)}px с защитой и экономикой`);
      } else if (hasDefense) {
        // Дальний форпост только с защитой — малая награда
        reward += 8.0;
        reasons.push(`DEEP_DEFENDED_OUTPOST: форпост на ${dist.toFixed(0)}px с защитой`);
      } else {
        // 🔥 ШТРАФ: Дальний форпост без защиты — уязвимая цель
        reward -= 12.0;
        reasons.push(`VULNERABLE_DEEP_OUTPOST: форпост на ${dist.toFixed(0)}px БЕЗ защиты!`);
      }
    } else if (dist > 350) {
      if (hasDefense && hasEconomy) {
        reward += 12.0;
        reasons.push(`MEDIUM_SECURED_OUTPOST: форпост на ${dist.toFixed(0)}px с защитой и экономикой`);
      } else if (hasDefense) {
        reward += 5.0;
        reasons.push(`MEDIUM_DEFENDED_OUTPOST: форпост на ${dist.toFixed(0)}px с защитой`);
      } else {
        // 🔥 ШТРАФ: Средний форпост без защиты
        reward -= 8.0;
        reasons.push(`VULNERABLE_MEDIUM_OUTPOST: форпост на ${dist.toFixed(0)}px БЕЗ защиты!`);
      }
    }
  });
}
  
  // 4. Проверяем кластеризацию зданий (штраф за кучкование)
  if (aiBuildings.length >= 5) {
    let totalDist = 0;
    let pairCount = 0;
    
    for (let i = 0; i < Math.min(aiBuildings.length, 15); i++) {
      for (let j = i + 1; j < Math.min(aiBuildings.length, 15); j++) {
        totalDist += Math.hypot(
          aiBuildings[i].x - aiBuildings[j].x,
          aiBuildings[i].y - aiBuildings[j].y
        );
        pairCount++;
      }
    }
    
    const avgDist = pairCount > 0 ? totalDist / pairCount : 0;
    
    if (avgDist < 150) {
      const clusterPenalty = -15.0;
      reward += clusterPenalty;
      reasons.push(`BUILDING_CLUSTER: здания слишком близко (среднее ${avgDist.toFixed(0)}px)`);
    } else if (avgDist < 250) {
      const minorPenalty = -5.0;
      reward += minorPenalty;
      reasons.push(`SLIGHT_CLUSTER: здания близко (среднее ${avgDist.toFixed(0)}px)`);
    } else if (avgDist > 400) {
      reward += 10.0;
      reasons.push(`GOOD_SPREAD: здания хорошо распределены (среднее ${avgDist.toFixed(0)}px)`);
    }
  }
  
  // 5. Награда за разнообразие зданий на разных позициях
const buildingTypes = new Set(aiBuildings.map(b => b.type));
// 🔥 ШТРАФ ЗА ОДНОТИПНЫЕ ЗДАНИЯ (кучкование одного типа)
const typeCounts = {};
aiBuildings.forEach(b => {
  typeCounts[b.type] = (typeCounts[b.type] || 0) + 1;
});
const maxSameType = Math.max(...Object.values(typeCounts));
if (maxSameType >= 4 && aiBuildings.length >= 6) {
  const spamPenalty = -10.0;
  reward += spamPenalty;
  reasons.push(`BUILDING_SPAM: ${maxSameType} зданий одного типа — кучкование!`);
}
// 🔥 НАГРАДА ЗА РЕАЛЬНУЮ ЭКСПАНСИЮ (расстояние между кластерами)
if (aiBuildings.length >= 5) {
  // Находим центроиды кластеров зданий
  const clusters = [];
  const visited = new Set();
  
  for (let i = 0; i < aiBuildings.length; i++) {
    if (visited.has(i)) continue;
    
    const cluster = [aiBuildings[i]];
    visited.add(i);
    // Ищем все здания в радиусе 300px от текущего
    for (let j = i + 1; j < aiBuildings.length; j++) {
      if (visited.has(j)) continue;
      const dist = Math.hypot(aiBuildings[i].x - aiBuildings[j].x, aiBuildings[i].y - aiBuildings[j].y);
      if (dist < 300) {
        cluster.push(aiBuildings[j]);
        visited.add(j);
      }
    }
    // Центроид кластера
    const cx = cluster.reduce((s, b) => s + b.x, 0) / cluster.length;
    const cy = cluster.reduce((s, b) => s + b.y, 0) / cluster.length;
    clusters.push({ x: cx, y: cy, size: cluster.length });
  }
  // Считаем среднее расстояние между кластерами
  if (clusters.length >= 2) {
    let totalClusterDist = 0;
    let pairCount = 0;
    
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        totalClusterDist += Math.hypot(clusters[i].x - clusters[j].x, clusters[i].y - clusters[j].y);
        pairCount++;
      }
    }
    
    const avgClusterDist = totalClusterDist / pairCount;
    // 🔥 НАГРАДА ЗА ХОРОШЕЕ РАСПРЕДЕЛЕНИЕ (кластеры далеко друг от друга)
    if (avgClusterDist > 400) {
      const spreadBonus = Math.min(15.0, (avgClusterDist - 400) / 50);
      reward += spreadBonus;
      reasons.push(`GOOD_EXPANSION: ${clusters.length} кластеров, среднее расстояние ${avgClusterDist.toFixed(0)}px (+${spreadBonus.toFixed(1)})`);
    } else if (avgClusterDist < 200 && clusters.length >= 2) {
      // 🔥 ШТРАФ ЗА КУЧКОВАНИЕ КЛАСТЕРОВ
      const clusterPenalty = -15.0;
      reward += clusterPenalty;
      reasons.push(`CLUSTERED_EXPANSION: все кластеры слишком близко (${avgClusterDist.toFixed(0)}px)`);
    }
  }
}
// 🔥 НАГРАДА ЗА НОВЫЕ ТИПЫ ЗДАНИЙ (только если они далеко от базы)
if (buildingTypes.size >= 4) {
  // Проверяем, есть ли здания далеко от базы (>400px)
  const farBuildings = aiBuildings.filter(b => {
    const dist = Math.hypot(b.x - aiBase.x, b.y - aiBase.y);
    return dist > 400;
  });
  if (farBuildings.length >= 2) {
    // Есть реальная экспансия — небольшая награда за разнообразие
    reward += 3.0;
    reasons.push(`DIVERSITY_WITH_EXPANSION: ${buildingTypes.size} типов зданий, ${farBuildings.length} далеко от базы`);
  }
  // Если все здания близко — НЕ награждаем (убрали +8)
}
  
  // 6. Штраф за отсутствие маяков при наличии ресурсов
  if (gameTimeMin > 3.0 && beacons.length === 0 && m.resTotal > 0.3) {
    reward -= 12.0;
    reasons.push("NO_BEACONS: есть ресурсы, но нет маяков для экспансии");
  }
  
// 🔥 7. БОНУС ЗА ЭКСПАНСИЮ В РАННЕЙ ИГРЕ — ИСПРАВЛЕННАЯ ВЕРСИЯ
// ==========================================
// 🔥 ИСПРАВЛЕНИЕ: Награда только за ПОЛНОЦЕННУЮ раннюю экспансию (2+ форпоста до 4 минут)
if (gameTimeMin < 4.0 && outposts.length > 0) {
  if (outposts.length >= 2) {
    // Отличная ранняя экспансия — большая награда
    reward += 30.0;
    reasons.push(`EXCELLENT_EARLY_EXPANSION: ${outposts.length} форпостов до 4 минут!`);
  } else if (outposts.length === 1) {
    // Минимальная ранняя экспансия — малая награда
    reward += 10.0;
    reasons.push("BASIC_EARLY_EXPANSION: 1 форпост до 4 минут");
  }
}

// 🔥 НОВОЕ: Штраф за отсутствие экспансии в средней игре
if (gameTimeMin >= 4.0 && gameTimeMin < 7.0 && outposts.length === 0 && m.resTotal > 0.2) {
  reward -= 20.0;
  reasons.push("MID_GAME_NO_EXPANSION: 4-7 минут, нет форпостов при ресурсах > 400!");
}

// 🔥 НОВОЕ: Штраф за отсутствие экспансии в поздней игре
if (gameTimeMin >= 7.0 && outposts.length < 2 && m.resTotal > 0.3) {
  reward -= 25.0;
  reasons.push("LATE_GAME_NO_EXPANSION: 7+ минут, <2 форпостов при ресурсах > 600!");
}
},


 
// ==========================================
// 🔥 НАГРАДА ЗА РАЗВЕДКУ НОВЫХ УЗЛОВ — ИСПРАВЛЕННАЯ ВЕРСИЯ
// ==========================================
evaluateReconDiscovery: function (now) {
  if (!this.lastReconDiscoveryCheck || now - this.lastReconDiscoveryCheck < 2000) return;
  this.lastReconDiscoveryCheck = now;
  let reward = 0;
  let reasons = [];
  const gameTimeMin = performance.now() / 60000;
  
  // 🔥 ИСПРАВЛЕНИЕ: Считаем только РЕАЛЬНО ценные открытия (не просто "новые узлы")
  const recentDiscoveries = [];
  const valuableDiscoveries = [];
  
  for (const [key, mem] of this.reconMemory.entries()) {
    if (mem.owner === "player" && (now - mem.lastSeen) < 2000) {
      // 🔥 Проверяем, что это ПЕРВОЕ обнаружение (не повторное)
      if (!mem._rewarded) {
        recentDiscoveries.push(mem);
        mem._rewarded = true;
        mem._firstSeenAt = now; // Фиксируем время первого обнаружения
        
        // 🔥 Оцениваем ценность открытия
        const isImportant = ["base","base2","base3","barracks","barracks2","barracks3","warehouse","turret","turret2","turret3"].includes(mem.type);
        const isEconomic = ["warehouse","repairWorkshop"].includes(mem.type);
        const isMilitary = ["turret","turret2","turret3","barracks","barracks2","barracks3"].includes(mem.type);
        
        if (isImportant) {
          valuableDiscoveries.push({
            mem,
            value: isMilitary ? 15.0 : (isEconomic ? 12.0 : 20.0) // База = 20, военное = 15, экономика = 12
          });
        }
      }
    }
  }
  
  // 🔥 НАГРАДА ЗА ОТКРЫТИЯ (но с ограничениями)
  if (recentDiscoveries.length > 0) {
    // 🔥 ОГРАНИЧЕНИЕ: Максимум 3 открытия за тик (предотвращает спам маяками)
    const cappedDiscoveries = Math.min(3, recentDiscoveries.length);
    const discoveryReward = cappedDiscoveries * 3.0; // 🔥 Было 5.0, стало 3.0
    reward += discoveryReward;
    reasons.push(`RECON_DISCOVERY: обнаружено ${recentDiscoveries.length} объектов (учтено ${cappedDiscoveries}, +${discoveryReward.toFixed(1)})`);
    
    // 🔥 Бонус за ценные открытия (но только если они РЕАЛЬНО новые)
    if (valuableDiscoveries.length > 0) {
      // 🔥 ОГРАНИЧЕНИЕ: Максимум 2 ценных открытия за тик
      const cappedValuable = valuableDiscoveries.slice(0, 2);
      const importantReward = cappedValuable.reduce((sum, d) => sum + d.value, 0);
      reward += importantReward;
      reasons.push(`IMPORTANT_RECON: ${cappedValuable.length} важных целей (+${importantReward.toFixed(1)})`);
    }
  }
  
  // 🔥 НОВОЕ: Штраф за "бесполезную разведку" (открыли только ресурсы, но не врагов)
  const enemyDiscoveries = recentDiscoveries.filter(d => d.owner === "player");
  const resourceDiscoveries = recentDiscoveries.filter(d => d.owner === "neutral" && ["gold","silicon","plasma"].includes(d.type));
  
  if (recentDiscoveries.length > 0 && enemyDiscoveries.length === 0 && gameTimeMin > 2.0) {
    // Открыли только ресурсы, но не врагов — небольшой штраф
    reward -= 2.0;
    reasons.push("USELESS_RECON: открыли только ресурсы, но не врагов");
  }
  
  // 🔥 НОВОЕ: Штраф за "переоткрытие" одних и тех же зон (если маяки стоят на месте)
  const staleDiscoveries = Array.from(this.reconMemory.values()).filter(m => 
    m.owner === "player" && m._rewarded && (now - m._firstSeenAt) > 30000 // Открыто более 30 секунд назад
  );
  
  if (staleDiscoveries.length > 5 && recentDiscoveries.length === 0 && gameTimeMin > 3.0) {
    // Долго знаем о врагах, но не открываем ничего нового — штраф за стагнацию разведки
    reward -= 5.0;
    reasons.push("STALE_RECON: нет новых открытий, хотя знаем о врагах");
  }
  
  // 🔥 Штраф за долгое отсутствие разведки (если память пустая или очень старая)
  const enemyNodesInMemory = Array.from(this.reconMemory.values()).filter(m => m.owner === "player");
  if (enemyNodesInMemory.length === 0 && gameTimeMin > 1.0) {
    reward -= 5.0; // 🔥 Было -3.0, стало -5.0
    reasons.push("BLIND: нет информации о враге!");
  }
  
  // 🔥 НОВОЕ: Штраф за "слепоту" в поздней игре (если знаем мало о враге)
  if (gameTimeMin > 5.0 && enemyNodesInMemory.length < 3) {
    reward -= 8.0;
    reasons.push("LATE_GAME_BLINDNESS: 5+ минут, но знаем только о ${enemyNodesInMemory.length} вражеских объектах!");
  }
  
  // 🔥 НОВОЕ: Бонус за "активную разведку" (юниты далеко от базы видят врагов)
  const combatUnits = gameState.units.filter(u => 
    u.owner === "ai" && ["fighter","assault","elite"].includes(u.type) && u.health > 0
  );
  
  let activeReconCount = 0;
  combatUnits.forEach(u => {
    const distFromBase = Math.hypot(u.x - aiBase.x, u.y - aiBase.y);
    if (distFromBase > 400) {
      // Юнит далеко от базы
      const enemiesNearUnit = gameState.units.filter(e => 
        e.owner === "player" && e.health > 0 && 
        Math.hypot(e.x - u.x, e.y - u.y) < 300
      ).length;
      
      if (enemiesNearUnit > 0) {
        activeReconCount++;
      }
    }
  });
  
  if (activeReconCount > 0) {
    const activeReconBonus = Math.min(10.0, activeReconCount * 3.0);
    reward += activeReconBonus;
    reasons.push(`ACTIVE_RECON: ${activeReconCount} юнитов далеко от базы видят врагов (+${activeReconBonus.toFixed(1)})`);
  }
  
  if (reward !== 0) {
    const state = this.buildGraphState();
    if (state) {
      this.replay.push({ X: state.X, A_distance: state.A_distance, A_threat: state.A_threat, actionIndex: AIDX.idle, reward });
      if (reward > 0) console.log(`[GnnAI] 🔭 Разведка: +${reward.toFixed(1)} (${reasons.join(', ')})`);
      else console.warn(`[GnnAI] ⚠️ Разведка: ${reward.toFixed(1)} (${reasons.join(', ')})`);
    }
  }
},

// ==========================================
// 🔥 ОЦЕНКА ФАЗОВЫХ НАГРАД — ИСПРАВЛЕННАЯ ВЕРСИЯ
// ==========================================
evaluatePhaseRewards: function (now) {
if (!this.lastPhaseCheck || now - this.lastPhaseCheck < 5000) return;
this.lastPhaseCheck = now;
const m = this.metrics();
const gameTimeMin = performance.now() / 60000;

// 🔥 СЧИТАЕМ ПРИЗНАКИ СОСТОЯНИЯ
const workers = gameState.units.filter(u => u.owner === "ai" && u.type === "worker" && u.health > 0).length;
const warehouses = gameState.buildings.filter(b => b.owner === "ai" && b.type === "warehouse" && b.active).length;
const hasBarracks = gameState.buildings.some(b => b.owner === "ai" && b.type === "barracks" && b.active);
const hasBase2 = gameState.buildings.some(b => b.owner === "ai" && b.type === "base2" && b.active);
const hasBarracks2 = gameState.buildings.some(b => b.owner === "ai" && b.type === "barracks2" && b.active);
const hasBase3 = gameState.buildings.some(b => b.owner === "ai" && b.type === "base3" && b.active);
const hasBarracks3 = gameState.buildings.some(b => b.owner === "ai" && b.type === "barracks3" && b.active);
const armySize = m.aiArmy;

// ==========================================
// 🔥 ПРИНУДИТЕЛЬНАЯ СИНХРОНИЗАЦИЯ ТИРОВ С РЕАЛЬНЫМИ ЗДАНИЯМИ
// ==========================================
const hasBase2Now = gameState.buildings.some(b => b.owner === "ai" && b.type === "base2" && b.active);
const hasBarracks2Now = gameState.buildings.some(b => b.owner === "ai" && b.type === "barracks2" && b.active);
const hasTurret2Now = gameState.buildings.some(b => b.owner === "ai" && b.type === "turret2" && b.active);
const hasBarracksNow = gameState.buildings.some(b => b.owner === "ai" && b.type === "barracks" && b.active);

// ==========================================
// 🔥 CURRICULUM КАК "ТРЕКЕР ДОСТИЖЕНИЙ" (Больше не блокирует действия!)
const currentTier = this.curriculumTier;

if (currentTier === 0 && warehouses >= 2 && workers >= 4) {
    this.curriculumTier = 1;
    console.log(`[Curriculum] 🎓 Milestone: Tier 1 (Экономика стабильна)`);
}
else if (currentTier === 1 && hasBarracks && armySize >= 2) {
    this.curriculumTier = 2;
    console.log(`[Curriculum] 🎓 Milestone: Tier 2 (Есть казарма и армия)`);
}
else if (currentTier === 2 && hasBarracks2 && hasTurret2) {
    this.curriculumTier = 3;
    console.log(`[Curriculum] 🎓 Milestone: Tier 3 (Технологии Тир-2 освоены)`);
}
// ==========================================
// 🔥 КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: НАГРАДА ЗА МОМЕНТ ПЕРЕХОДА НА ТИР
// ==========================================
const currentTechLevel = m.techLevel;
let phaseReward = 0;
let reasons = [];

// 🔥 НОВОЕ: Отслеживаем момент перехода на новый тир
if (!this._lastRewardedTechLevel) this._lastRewardedTechLevel = 1;

if (currentTechLevel > this._lastRewardedTechLevel) {
  // Произошёл переход на новый тир!
  if (currentTechLevel === 2) {
    // 🔥 ПЕРЕХОД НА ТИР 2: БОЛЬШАЯ НАГРАДА
    phaseReward += 100.0;
    reasons.push("🏆 TIER2_TRANSITION: Переход на Тир-2! Бонус +100");
    
    // Дополнительный бонус за скорость перехода
    if (gameTimeMin < 5.0) {
      phaseReward += 50.0;
      reasons.push("⚡ FAST_TIER2: Переход на Тир-2 до 5 минут! +50");
    } else if (gameTimeMin < 7.0) {
      phaseReward += 25.0;
      reasons.push("👍 GOOD_TIER2: Переход на Тир-2 до 7 минут! +25");
    }
  }
  else if (currentTechLevel === 3) {
    // 🔥 ПЕРЕХОД НА ТИР 3: ОГРОМНАЯ НАГРАДА
    phaseReward += 200.0;
    reasons.push("🏆🏆 TIER3_TRANSITION: Переход на Тир-3! Бонус +200");
    
    // Дополнительный бонус за скорость перехода
    if (gameTimeMin < 10.0) {
      phaseReward += 100.0;
      reasons.push("⚡⚡ FAST_TIER3: Переход на Тир-3 до 10 минут! +100");
    } else if (gameTimeMin < 13.0) {
      phaseReward += 50.0;
      reasons.push("👍 GOOD_TIER3: Переход на Тир-3 до 13 минут! +50");
    }
  }
  
  this._lastRewardedTechLevel = currentTechLevel;
}

// 🔥 НОВОЕ: Штраф за ЗАСТРЕВАНИЕ на текущем тире (прогрессирующий)
const timeSinceLastTier = this._lastTierTransitionTime ? (now - this._lastTierTransitionTime) / 60000 : gameTimeMin;

if (currentTechLevel === 1 && gameTimeMin > 5.0) {
  // Застряли на Тир-1 после 5 минут
  const stagnationPenalty = -15.0 * (gameTimeMin - 5.0);
  phaseReward += Math.max(-100.0, stagnationPenalty); // Лимит -100
  reasons.push(`🐌 TIER1_STAGNATION: ${gameTimeMin.toFixed(1)} мин на Тир-1 (штраф ${stagnationPenalty.toFixed(1)})`);
}
else if (currentTechLevel === 2 && gameTimeMin > 12.0) {
  // Застряли на Тир-2 после 12 минут
  const stagnationPenalty = -10.0 * (gameTimeMin - 12.0);
  phaseReward += Math.max(-80.0, stagnationPenalty);
  reasons.push(`🐌 TIER2_STAGNATION: ${gameTimeMin.toFixed(1)} мин на Тир-2 (штраф ${stagnationPenalty.toFixed(1)})`);
}

// 🔥 НОВОЕ: Обновляем время последнего перехода
if (currentTechLevel > (this._lastKnownTechLevel || 1)) {
  this._lastTierTransitionTime = now;
  this._lastKnownTechLevel = currentTechLevel;
}

// ==========================================
// 🟡 СТАНДАРТНЫЕ ФАЗОВЫЕ НАГРАДЫ (сохраняем оригинальную логику)
// ==========================================
const barracks = gameState.buildings.some(b => b.owner === "ai" && b.type === "barracks");

if (gameTimeMin < 2.0) {
  const wCount = workers;
  const barr = hasBarracks;
  if (wCount >= 4) { phaseReward += 20.0; reasons.push("PHASE1_EXCELLENT_ECONOMY_4+_WORKERS"); } 
  else if (wCount >= 2) { phaseReward += 10.0; reasons.push("PHASE1_GOOD_ECONOMY_2+_WORKERS"); } 
  else if (wCount >= 1) { phaseReward += 3.0; reasons.push("PHASE1_BASIC_ECONOMY"); }
  if (gameTimeMin > 1.0 && wCount < 2) { phaseReward -= 30.0; reasons.push("PHASE1_CRITICAL_ECONOMIC_STAGNATION"); }
  if (gameTimeMin > 1.5 && m.aiWarehouses < 2) { phaseReward -= 20.0; reasons.push("PHASE1_LACK_OF_INFRASTRUCTURE"); }
  if (barr && wCount < 3) { phaseReward -= 30.0; reasons.push("PHASE1_PREMATURE_MILITARY_SUICIDE"); }
}
else if (gameTimeMin < 4.0) {
  const wCount = workers;
  const barr = hasBarracks;
  if (barr && wCount >= 4) { phaseReward += 20.0; reasons.push("PHASE2_PERFECT_MACRO_BALANCE"); }
  if (m.resTotal > 100 && m.aiWarehouses < 2) { phaseReward -= 25.0; reasons.push("PHASE2_HOARDING_WITHOUT_EXPANSION"); }
  if (armySize > 0 && wCount < 3) { phaseReward -= 15.0; reasons.push("PHASE2_ATTACKING_WITH_WEAK_ECONOMY"); }
  if (armySize === 0 && gameTimeMin > 3.0) { phaseReward -= 15.0; reasons.push("PHASE2_ZERO_ARMY_PENALTY"); }
}
else if (gameTimeMin < 6.0) {
  // 🔥 ИСПРАВЛЕНИЕ: Усиленная награда за Тир-2 в фазе 3
  if (hasBase2) { 
    phaseReward += 30.0; // 🔥 Было 12.0, стало 30.0
    reasons.push("PHASE3_TIER2_ACHIEVEMENT_BONUS"); 
  }
  if (!hasBase2) {
    const minutesLate = gameTimeMin - 3.0;
    phaseReward -= (8.0 * minutesLate); // 🔥 Было 5.0, стало 8.0
    reasons.push(`PHASE3_TIER1_STAGNATION_PENALTY (-${(8.0 * minutesLate).toFixed(1)})`);
  }
}
else {
  const eliteCount = gameState.units.filter(u => u.owner === "ai" && u.type === "elite").length;
  const assaultCount = gameState.units.filter(u => u.owner === "ai" && u.type === "assault").length;
  
  // 🔥 ИСПРАВЛЕНИЕ: Награда за Тир-3 юнитов
  if (eliteCount > 0) { 
    phaseReward += 20.0; // 🔥 Было 10.0, стало 20.0
    reasons.push("PHASE4_ELITE_UNITS_BONUS"); 
  }
  if (assaultCount > 0) {
    phaseReward += 10.0;
    reasons.push("PHASE4_ASSAULT_UNITS_BONUS");
  }
  
  if (armySize > 10) {
    const fighterCount = gameState.units.filter(u => u.owner === "ai" && u.type === "fighter").length;
    if (fighterCount / armySize > 0.9) { phaseReward -= 8.0; reasons.push("PHASE4_INEFFICIENT_ARMY_COMPOSITION_PENALTY"); }
  }
  
  // 🔥 НОВОЕ: Штраф за отсутствие Тир-3 в поздней игре
  if (gameTimeMin > 15.0 && currentTechLevel < 3) {
    phaseReward -= 20.0;
    reasons.push("PHASE4_LATE_GAME_NO_TIER3: 15+ мин, но нет Тир-3!");
  }
}

if (phaseReward !== 0) {
  const currentState = this.buildGraphState();
  if (currentState) {
    this.replay.push({ X: currentState.X, A_distance: currentState.A_distance, A_threat: currentState.A_threat, actionIndex: AIDX.idle, reward: phaseReward });
    
    // 🔥 НОВОЕ: Логируем важные переходы тиров
    if (reasons.some(r => r.includes("TIER2_TRANSITION") || r.includes("TIER3_TRANSITION"))) {
      console.log(`[GnnAI] 🎯 ФАЗА: +${phaseReward.toFixed(1)} (${reasons.join(', ')})`);
    } else if (phaseReward < -10) {
      console.warn(`[GnnAI] ⚠️ ФАЗА: ${phaseReward.toFixed(1)} (${reasons.join(', ')})`);
    }
  }
}
},
	  
checkTechStagnation: function (now) {
  if (!this.lastTechStagnationCheck || now - this.lastTechStagnationCheck < 10000) return;
  this.lastTechStagnationCheck = now;
  const m = this.metrics();
  const gameTimeMin = performance.now() / 60000;
  let penalty = 0;
  let reasons = [];	
  
  const isUnderThreat = this.strategicMemory.threatLevel > 0;
  const hasNoArmy = m.aiArmy === 0;

  // 1. Паника: ресурсы есть, армии нет
  if (hasNoArmy && m.resTotal > 0.2 && gameTimeMin > 1.5) {
      penalty -= 30.0;
      reasons.push("CRITICAL_PANIC: Ресурсы есть, а армии НЕТ! Строй казарму!");
  }			
  
  // 2. Ловушка пацифиста: турели есть, армии нет
  if (m.aiTurrets >= 3 && m.aiArmy === 0 && gameTimeMin > 3) {
    penalty -= 10.0;
    reasons.push("CRITICAL: turrets_but_no_army_PACIFIST_TRAP");
  }
  
  const hasEconomyBuildings = gameState.buildings.some(b => b.owner === "ai" && (b.type ==="warehouse" || b.type ==="repairWorkshop") && b.active);
  const workerCount = gameState.units.filter(u => u.owner === "ai" && u.type ==="worker" && u.health > 0).length;

  if (hasEconomyBuildings && workerCount === 0 && gameTimeMin > 0.5) {
      penalty -= 20.0;
      reasons.push("CRITICAL: buildings_without_workers_ECONOMIC_SUICIDE");
  }
  if (workerCount === 0 && gameTimeMin > 1) {
      const minutesWithoutWorkers = gameTimeMin - 1;
      penalty -= 10.0 * minutesWithoutWorkers;
      reasons.push(`CRITICAL: no_workers_${minutesWithoutWorkers.toFixed(1)}min`);
  }
  if (m.resTotal > 0.1 && m.aiBuildings <= 2 && gameTimeMin > 0.5) {
     penalty -= 50.0;
     reasons.push("LAZY_PENALTY: Есть ресурсы, но ИИ ничего не делает!");
  }
  
  const currentRes = m.resTotal;
  if (this.lastResourceTotal > 0) {
      const resourceGrowth = currentRes - this.lastResourceTotal;
      if (resourceGrowth <= 0 && gameTimeMin > 0.3 && workerCount === 0) {
          penalty -= 15.0;
          reasons.push("CRITICAL: zero_resource_income_no_workers");
      }
  }
  
  const units = gameState.units.filter(u => u.owner === "ai" && u.health > 0);
  const combatUnits = units.filter(u => ["fighter","assault","elite"].includes(u.type));
  const fighterCount = combatUnits.filter(u => u.type === "fighter").length;
  const assaultCount = combatUnits.filter(u => u.type === "assault").length;
  const eliteCount = combatUnits.filter(u => u.type === "elite").length;
  const totalArmy = combatUnits.length;
  
  if (totalArmy > 15 && gameTimeMin > 5) {
      const fighterRatio = fighterCount / totalArmy;
      if (fighterRatio > 0.8) { penalty -= 8.0; reasons.push("inefficient_army_composition_80_percent_fighters"); }
      if (fighterRatio > 0.9) { penalty -= 12.0; reasons.push("terrible_army_composition_90_percent_fighters"); }
  }
  const uniqueTypes = (fighterCount > 0 ? 1 : 0) + (assaultCount > 0 ? 1 : 0) + (eliteCount > 0 ? 1 : 0);
  if (uniqueTypes >= 2 && gameTimeMin > 6) { penalty += 5.0; reasons.push("diverse_army_bonus"); }
  if (uniqueTypes === 3 && gameTimeMin > 8) { penalty += 10.0; reasons.push("full_composition_bonus"); }

  // ==========================================
  // 🔥 ПРОВЕРКА ТЕХНОЛОГИЧЕСКОГО ПРОГРЕССА (ПЕРЕД НОВЫМИ ШТРАФАМИ)
  // ==========================================
  const hasBarracks = gameState.buildings.some(b => b.owner === "ai" && b.type ==="barracks" && b.active);
  const hasBase2 = gameState.buildings.some(b => b.owner === "ai" && b.type ==="base2" && b.active);
  const hasBase3 = gameState.buildings.some(b => b.owner === "ai" && b.type ==="base3" && b.active);
  const base2Wip = (window.buildQueue || []).some(q => q.type === "base2");
  const barracksWip = (window.buildQueue || []).some(q => q.type === "barracks");
  const base2Cost = typeof BASE2_COST !== 'undefined' ? (BASE2_COST.gold || 0) + (BASE2_COST.silicon || 0) + (BASE2_COST.plasma || 0) : 400;

  // ==========================================
  // 🔥 ШТРАФ ЗА ЗАДЕРЖКУ ПЕРЕХОДА НА ТИР 2 — ИСПРАВЛЕННАЯ ВЕРСИЯ
  // ==========================================
  // 1. Прогрессирующий штраф за отсутствие Base2 после 5 минут (вместо 8 минут)
  if (!hasBase2 && !base2Wip && gameTimeMin > 5.0) {
    const minutesLate = gameTimeMin - 5.0;
    const stagnationPenalty = -8.0 * minutesLate; // Усилено: -8 за каждую минуту
    penalty += Math.max(-80.0, stagnationPenalty); // Лимит -80
    reasons.push(`TIER2_DELAY_CRITICAL: ${gameTimeMin.toFixed(1)} мин, нет Base2 (штраф ${stagnationPenalty.toFixed(1)})`);
  }

  // 2. Дополнительный штраф: есть казарма, но нет Base2 после 4 минут
  if (hasBarracks && !hasBase2 && !base2Wip && gameTimeMin > 4.0) {
    const minutesLate = gameTimeMin - 4.0;
    const barracksPenalty = -10.0 * minutesLate;
    penalty += Math.max(-60.0, barracksPenalty);
    reasons.push(`BARRACKS_BUT_NO_BASE2: есть казарма, но нет Base2 после 4 мин (штраф ${barracksPenalty.toFixed(1)})`);
  }

  // 3. Штраф за бездействие, если ресурсов УЖЕ хватает на Base2 (80% стоимости)
  // m.resTotal нормализован (делится на 2000), поэтому сравниваем с (base2Cost / 2000) * 0.8
  if (m.resTotal >= (base2Cost / 2000) * 0.8 && !hasBase2 && !base2Wip && gameTimeMin > 3.5) {
    const hoardingPenalty = -15.0;
    penalty += hoardingPenalty;
    reasons.push(`CAN_AFFORD_BASE2: ресурсов хватает на Base2, но ИИ бездействует! (штраф ${hoardingPenalty})`);
  }

  // ==========================================
  // 🔥 УСИЛЕННЫЙ ШТРАФ "RICH FOOL" (Много ресурсов, но застрял на Тир-1)
  // ==========================================
  // Было: порог > 800 и штраф -25.0
  // Стало: порог ниже (> 0.3 нормализованных, т.е. ~600 сырых), штраф -40.0
  if (m.resTotal > Math.max(0.3, (base2Cost / 2000)) && !hasBase2 && !hasBase3 && !base2Wip && gameTimeMin > 3.0) {
    penalty -= 40.0; // 🔥 УСИЛЕНО с -25.0 до -40.0
    reasons.push("RICH_FOOL_CRITICAL: Много ресурсов, но застревание на Тир-1! Срочно строй Base2!");
  }

  // ==========================================
  // 🔥 ШТРАФ ЗА МАЯКИ-СИРОТЫ (Твой исправленный блок)
  // ==========================================
  const orphanBeacons = gameState.buildings.filter(b =>
    b.owner === "ai" && b.type === "beacon" && b.active &&
    !gameState.buildings.some(o => o.owner === "ai" && o !== b &&
      ["warehouse","repairWorkshop","turret","turret2","turret3","barracks"].includes(o.type) &&
      Math.hypot(o.x - b.x, o.y - b.y) < 220)
  );

  if (orphanBeacons.length >= 1 && gameTimeMin > 2) {
    let orphanPenalty = 0;
    for (let i = 0; i < orphanBeacons.length; i++) {
      if (i === 0) orphanPenalty -= 10.0;
      else if (i === 1) orphanPenalty -= 15.0;
      else if (i === 2) orphanPenalty -= 20.0;
      else orphanPenalty -= 25.0;
    }
    penalty += orphanPenalty;
    reasons.push(`ORPHAN_BEACONS_CRITICAL: ${orphanBeacons.length} маяков без фортов! (штраф ${orphanPenalty.toFixed(1)}, прогрессивный)`);
  }

  orphanBeacons.forEach(beacon => {
    const beaconAge = (performance.now() - (beacon.builtAt || performance.now())) / 1000;
    if (beaconAge > 60) {
      const agePenalty = -5.0 * Math.min(3, Math.floor(beaconAge / 60));
      penalty += agePenalty;
      reasons.push(`STALE_ORPHAN_BEACON: маяк на (${beacon.x.toFixed(0)}, ${beacon.y.toFixed(0)}) существует ${beaconAge.toFixed(0)}с без фортов (штраф ${agePenalty.toFixed(1)})`);
    }
  });

  const totalResRaw = (m.res.gold || 0) + (m.res.silicon || 0) + (m.res.plasma || 0);
  const canAffordTurret = typeof TURRET_COST !== 'undefined' && 
    (m.res.gold || 0) >= (TURRET_COST.gold || 0) &&
    (m.res.silicon || 0) >= (TURRET_COST.silicon || 0) &&
    (m.res.plasma || 0) >= (TURRET_COST.plasma || 0);
  const canAffordWarehouse = typeof WAREHOUSE_COST !== 'undefined' && 
    (m.res.gold || 0) >= (WAREHOUSE_COST.gold || 0) &&
    (m.res.silicon || 0) >= (WAREHOUSE_COST.silicon || 0) &&
    (m.res.plasma || 0) >= (WAREHOUSE_COST.plasma || 0);

  if (orphanBeacons.length > 0 && (canAffordTurret || canAffordWarehouse) && gameTimeMin > 2.5) {
    const hoardingPenalty = -12.0 * orphanBeacons.length;
    penalty += hoardingPenalty;
    reasons.push(`ORPHAN_BEACONS_HOARDING: есть ресурсы на достройку, но ИИ бездействует! (штраф ${hoardingPenalty.toFixed(1)})`);
  }

  orphanBeacons.forEach(beacon => {
    const enemiesNearBeacon = gameState.units.filter(u => 
      u.owner === "player" && u.health > 0 && 
      Math.hypot(u.x - beacon.x, u.y - beacon.y) < 400
    ).length;
    
    if (enemiesNearBeacon > 0) {
      const vulnerablePenalty = -15.0;
      penalty += vulnerablePenalty;
      reasons.push(`VULNERABLE_ORPHAN: маяк под угрозой (${enemiesNearBeacon} врагов рядом)! (штраф ${vulnerablePenalty})`);
    }
  });

  // ==========================================
  // СТАНДАРТНЫЕ ПРОВЕРКИ (остались без изменений)
  // ==========================================
  if (hasBarracks && hasBase2 && m.aiArmy > 5 && gameTimeMin > 5) { penalty += 2.0; reasons.push("balanced_development"); }

  if (!hasBarracks && !barracksWip && gameTimeMin > 3) {
      const minutesLate = gameTimeMin - 3;
      penalty -= 3.0 * minutesLate;
      reasons.push(`no_barracks_${minutesLate.toFixed(1)}min_late`);
  }     
  
  if (gameTimeMin > 12 && !hasBase3) { penalty -= 4.0; reasons.push("no_base3_by_12min"); }

  const turretCount = gameState.buildings.filter(b => b.owner === "ai" && b.type?.startsWith("turret") && b.active).length;
  if (turretCount > 5 && m.aiArmy < 3 && gameTimeMin > 5) { penalty -= 2.0; reasons.push("turrets_without_army"); }
  
  if (penalty !== 0) {
    const currentState = this.buildGraphState();
    if (currentState) {
      this.replay.push({ X: currentState.X, A_distance: currentState.A_distance, A_threat: currentState.A_threat, actionIndex: AIDX.idle, reward: penalty });
    }
  }  
  this.lastResourceTotal = currentRes;
},

init: async function () {
  if (this.initialized) return;
  if (this._initializing) {
    while (this._initializing) await new Promise(r => setTimeout(r, 50));
    return;
  }
  this._initializing = true;
  if (!window.tf) { 
    console.error("[GnnAI] TF.js не найден"); 
    this._initializing = false; 
    return; 
  }  
  
  try {
    await tf.setBackend('webgpu').catch(() => tf.setBackend('webgl'));
    await tf.ready();
  } catch (e) {
    console.warn("[GnnAI] Backend fallback", e);
    try { 
      await tf.setBackend('webgl');
      await tf.ready();
    } catch (e2) {
      console.error("[GnnAI] Нет доступного backend", e2);
      this._initializing = false;
      return;
    }
  }

  // 👉 👉 👉 ВСТАВЛЯЕМ ОБРАБОТЧИК ЗДЕСЬ 👈 👈 👈
  // TF.js уже выбрал бэкенд, теперь мы вешаем "стража" на Canvas
  const canvas = document.querySelector('canvas');
  if (canvas) {
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault(); // Обязательно, чтобы браузер дал нам шанс на восстановление
      console.error("[GnnAI] 💥 WebGL контекст потерян!");
      
      setTimeout(() => {
        const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
        if (!gl || gl.isContextLost()) {
          console.error("[GnnAI] ❌ Контекст не восстановился. Перезагрузка страницы...");
          location.reload();
        } else {
          console.log("[GnnAI] ✅ Контекст успешно восстановлен браузером");
        }
      }, 2000);
    });
    
    canvas.addEventListener('webglcontextrestored', () => {
      console.log("[GnnAI] ✅ Событие webglcontextrestored получено");
      // Если контекст восстановился, нам, возможно, придется пересоздать переменные TF.js,
      // но пока оставим перезагрузку как самый надежный fallback, если восстановление не сработает.
    });
  }
  // 👆 👆 👆 КОНЕЦ ВСТАВКИ 👆 👆 👆

  // 🔥 КЛЮЧЕВОЕ ИЗМЕНЕНИЕ: Инициализируем БД ДО создания модели и начала игры
  await this.initWeightDB();
  
  const H = CFG.HIDDEN;
  const F = CFG.NODE_FEATURES;
  const G = CFG.GLOBAL_FEATURES;
  const A = G_ACTIONS.length; 
  const v = (shape, scale = 0.08) => tf.variable(tf.randomNormal(shape, 0, scale));
  
  const W_attn = v([F * 2, 1]);
  const W1 = v([F, H]), b1 = tf.variable(tf.zeros([H]));
  const W2 = v([H, H]), b2 = tf.variable(tf.zeros([H]));
  const Wp = v([H + G, H]), bp = tf.variable(tf.zeros([H]));   
  const W_adv = v([H, A]);
  const b_adv = tf.variable(tf.zeros([A]));     
  const W_val = v([H, 1]);
  const b_val = tf.variable(tf.zeros([1]));
  
  this.vars = [W_attn, W1, b1, W2, b2, Wp, bp, W_adv, b_adv, W_val, b_val];
  this.targetVars = this.vars.map(v => tf.variable(v.clone()));     
  this.optimizer = tf.train.adam(CFG.LR);
  this.tau = 0.005;

  this.model = {
    forwardBatch: (x, adj_dist, adj_threat, globalBatchTensor) => {  
      return tf.tidy(() => {
        const B = x.shape[0];
        const N = CFG.MAX_NODES;          
        const xExpanded = x.tile([1, 1, N]).reshape([B, N, N, F]);
        const xTransposed = x.expandDims(2).tile([1, 1, N, 1]);
        const pairFeat = tf.concat([xExpanded, xTransposed], 3).reshape([B * N * N, F * 2]);
        const attnLogits = tf.matMul(pairFeat, W_attn).reshape([B, N, N]);
        const attnWeights = tf.softmax(attnLogits, 2);           
        const combinedAdj = tf.add(
          tf.mul(adj_dist, attnWeights),
          tf.mul(adj_threat, attnWeights)
        );         
        const agg1 = tf.matMul(combinedAdj, x);
        const h1 = tf.relu(tf.matMul(agg1.reshape([B * N, F]), W1).add(b1).reshape([B, N, H]));          
        const agg2 = tf.matMul(combinedAdj, h1);
        const h2 = tf.relu(tf.matMul(agg2.reshape([B * N, H]), W2).add(b2).reshape([B, N, H]));           
        const mask = x.slice([0, 0, 0], [B, N, 1]);
        const pooled = h2.mul(mask).sum(1).div(tf.maximum(mask.sum(1), 1));            
        const combined = tf.concat([pooled, globalBatchTensor], 1);
        const hp = tf.tanh(tf.add(tf.matMul(combined, Wp), bp));         
        const advantage = tf.add(tf.matMul(hp, W_adv), b_adv);
        const value = tf.add(tf.matMul(hp, W_val), b_val);          
        const meanAdv = advantage.mean(1, true);
        const logits = value.add(advantage.sub(meanAdv));
        
        return { logits, value };
      });
    }
  };
  
  await this.loadWeights();
  this.initialized = true;
  this._initializing = false;
  console.log(`[GnnAI] ✅ Модель (v7.7) готова. Backend: ${tf.getBackend()}`);
},

  predictData: function (state) {
    if (!this.model) return null;
    return tf.tidy(() => {
        const globalFeatures = this.getGlobalFeatures();
        const x = tf.tensor2d(state.X).expandDims(0);
        const a_dist = tf.tensor2d(state.A_distance).expandDims(0);  
        const a_threat = tf.tensor2d(state.A_threat).expandDims(0);  
        const globalBatch = tf.tensor2d([globalFeatures]);     
        const result = this.model.forwardBatch(x, a_dist, a_threat, globalBatch);
        const logitsData = Array.from(result.logits.dataSync());
        const valueData = Array.from(result.value.dataSync());
        return { logits: logitsData, value: valueData };
    });
  },

    tick: async function () {
      if (!gameStarted || gameState.gameEnded || gameMode !== "gnn") return;
      if (!this.initialized) await this.init();
      if (!this.initialized) return; 

      const now = performance.now();
      this._wrapReplayPush();   // 🔥 идемпотентно, чинит и replay после reset()
      // 1. Оценка мира (без тензоров)
      try {
          await this.checkEnd();
          this.assessThreats();
          this.evaluatePhaseRewards(now); 
          this.checkTechStagnation(now);
          this.evaluateStagnation(now);
          this.evaluateMilitaryBalance(now);
          this.evaluateOpponentGap(now);
          this.evaluateArmyActivity(now);
          this.evaluateCombatEfficiency(now); 
          this.evaluateTargetSelection(now);
          this.evaluateRecon(now);
          this.evaluateExpansion(now);
          this.evaluateReconDiscovery(now);
          this.evaluateEconomyEfficiency(now);
          this.evaluateResourceControl(now);
          this.evaluateMissions();
          this.checkEconomicParalysis(now);
      } catch (e) {
          console.error("[GnnAI] Error in evaluation phase:", e);
      }
      // 2. Обработка очередей
      if (!this.lastTick.buildQ || now - this.lastTick.buildQ >= CFG.BUILD_QUEUE_MS) {
        this.lastTick.buildQ = now;
        if (typeof processBuildQueue === "function") {
          try { processBuildQueue(); } catch (e) { console.warn("[GnnAI] buildQ error", e); }
        }
      }

      if (CFG.AUTO_ECONOMY && (!this.lastTick.eco || now - this.lastTick.eco >= CFG.ECO_MS)) {
        this.lastTick.eco = now;
        this.autoEconomy();
      }

      this.evaluatePending(now);
      this.benchmarkTick("gnn", this.lastAction);
      // 3. Принятие решения (строго внутри tidy)
      if (!this.lastTick.decision || now - this.lastTick.decision >= CFG.DECISION_MS) {
        this.lastTick.decision = now;
        tf.tidy(() => {
            try { this.decide(); } catch(e) { console.error("[GnnAI] Decide error", e); }
        });
      }
      // 4. Обучение — РАЗНЕСЁННОЕ ПО КАДРАМ (без фризов)
      if (!this.lastTick.train || now - this.lastTick.train >= CFG.TRAIN_MS) {
        this.lastTick.train = now;
        // 🔥 Вместо одного тяжёлого trainBatch() делаем 4 маленьких шага
        // с паузой между ними через requestAnimationFrame
        this._trainStepsPending = 4;
        this._doTrainStep();
      }
    },

    _doTrainStep: function () {
  if (!this._trainStepsPending || this._trainStepsPending <= 0) return;
  this._trainStepsPending--;
  
  // Один маленький шаг обучения
  tf.tidy(() => {
    try {
      // Берём мини-батч из 8 сэмплов вместо полного BATCH_SIZE
      const miniBatch = [];
      const miniSize = Math.min(8, this.replay.length);
      for (let i = 0; i < miniSize; i++) {
        const sample = this.replay.getRandom();
        if (sample && sample.X && sample.A_distance && isFinite(sample.reward)) {
          miniBatch.push(sample);
        }
      }
      if (miniBatch.length < 4) return;
      
      // Паддинг до константы
      while (miniBatch.length < 8) {
        miniBatch.push(miniBatch[Math.floor(Math.random() * miniBatch.length)]);
      }
      const B = 8;
      
      const xs = tf.tensor3d(miniBatch.map(b => b.X), [B, CFG.MAX_NODES, CFG.NODE_FEATURES]);
      const as_dist = tf.tensor3d(miniBatch.map(b => b.A_distance), [B, CFG.MAX_NODES, CFG.MAX_NODES]);
      const as_threat = tf.tensor3d(miniBatch.map(b => b.A_threat), [B, CFG.MAX_NODES, CFG.MAX_NODES]);
      const act = tf.tensor1d(miniBatch.map(b => b.actionIndex), "int32");
      // 🔥 Мягкий сквош вместо жёсткого клиппинга:
      // +500 → +10, +300 → +9.96, +100 → +7.6, +15 → +1.5, -150 → -9.1
      const rew = tf.tensor1d(miniBatch.map(b => {
        const r = isFinite(b.reward) ? Math.max(-1000, Math.min(1000, b.reward)) : 0;
        return Math.tanh(r / 100) * 10;
      }), "float32");      const oldLogProbs = tf.tensor1d(miniBatch.map(b => isFinite(b.oldLogProb) ? b.oldLogProb : -10.0), "float32");
      const oldValues = tf.tensor1d(miniBatch.map(b => isFinite(b.value) ? b.value : 0.0), "float32");
      const maskTensor = tf.tensor2d(miniBatch.map(b => {
        let m = b.actionMask;
        if (!m || m.length !== G_ACTIONS.length) m = new Array(G_ACTIONS.length).fill(1);
        return m;
      }), [B, G_ACTIONS.length]);
      const globalFeatures = this.getGlobalFeatures().map(v => isFinite(v) ? v : 0);
      const globalBatch = tf.tensor2d(Array(B).fill(globalFeatures), [B, CFG.GLOBAL_FEATURES]);
      
   const { value, grads } = tf.variableGrads(() => {
     const { logits, value } = this.model.forwardBatch(xs, as_dist, as_threat, globalBatch);
     const clippedValue = tf.clipByValue(value, -50, 50);
     const inverseMask = maskTensor.sub(1).mul(-1e9);
     const maskedLogits = logits.add(inverseMask);
     const logProbs = tf.log(tf.softmax(maskedLogits).add(1e-10));
     const oneHot = tf.oneHot(act, G_ACTIONS.length);
     const newLogProbs = logProbs.mul(oneHot).sum(1);
     const values = clippedValue.squeeze();
     const advantage = rew.sub(values);
     const ratio = tf.exp(newLogProbs.sub(oldLogProbs));
     const clippedRatio = tf.clipByValue(ratio, 1 - CFG.CLIP_EPSILON, 1 + CFG.CLIP_EPSILON);
     const surrogate1 = ratio.mul(advantage);
     const surrogate2 = clippedRatio.mul(advantage);
     const actorLoss = tf.minimum(surrogate1, surrogate2).mul(-1).mean();
     const valueClipped = oldValues.add(tf.clipByValue(values.sub(oldValues), -0.5, 0.5));
     const criticLoss1 = values.sub(rew).square();
     const criticLoss2 = valueClipped.sub(rew).square();
     const criticLoss = tf.maximum(criticLoss1, criticLoss2).mean();
     const probs = tf.softmax(maskedLogits);
     const entropy = probs.mul(logProbs).mul(-1).sum(1).mean();
     
     // 🔥 ОБЪЯВЛЯЕМ totalLoss + используем динамическую энтропию
     const currentEntropyCoef = this.getEntropyCoef();
     const totalLoss = actorLoss.add(criticLoss.mul(0.5)).sub(entropy.mul(currentEntropyCoef));
     return totalLoss;
   }, this.vars);
      
      const gradValues = this.vars.map(v => grads[v.name]).filter(Boolean);
      let clipCoef = 1.0;
      if (gradValues.length > 0) {
        const sumSquares = gradValues.map(g => g.square().sum());
        const globalNorm = tf.addN(sumSquares).sqrt();
        const normVal = globalNorm.dataSync()[0];
        clipCoef = Math.min(1.0, CFG.GRADIENT_CLIP_NORM / (normVal + 1e-8));
        sumSquares.forEach(t => t.dispose());
        globalNorm.dispose();
      }
      
      const finalGrads = {};
      this.vars.forEach(v => {
        const g = grads[v.name];
        if (g) finalGrads[v.name] = g.mul(clipCoef);
        else finalGrads[v.name] = tf.zerosLike(v);
      });
      this.optimizer.applyGradients(finalGrads);
      this.vars.forEach(v => {
        if (grads[v.name]) grads[v.name].dispose();
        if (finalGrads[v.name]) finalGrads[v.name].dispose();
      });
      
      const lossVal = value.dataSync()[0];
      value.dispose();
      
      if (isFinite(lossVal)) {
        this.trainBatches++;
        if (this.trainBatches % 10 === 0) {
          console.log(`[GnnAI] Mini-batch ${this.trainBatches}, Loss: ${lossVal.toFixed(4)}`);
        }
        if (this.trainBatches % CFG.SAVE_EVERY_BATCHES === 0) {
          this.saveWeights();
        }
      }
    } catch (e) {
      console.error("[GnnAI] train step error", e);
    }
  });
  
  // 🔥 Следующий шаг через 1 кадр (не блокируем поток)
  if (this._trainStepsPending > 0) {
    requestAnimationFrame(() => this._doTrainStep());
  }
},

// 🔥 КЛАСТЕРИЗАЦИЯ ЮНИТОВ В ОТРЯДЫ (SQUADS)
clusterUnits: function(units, maxDist = 150) {
  const squads = [];
  
  for (const u of units) {
    let added = false;
    
    // Ищем подходящий отряд того же типа и владельца
    for (const squad of squads) {
      if (squad.baseType === u.type && squad.owner === u.owner) {
        const dist = Math.hypot(u.x - squad.x, u.y - squad.y);
        if (dist < maxDist) {
          squad.units.push(u);
          squad.count++;
          // Пересчитываем центр масс отряда
          squad.x = squad.units.reduce((s, unit) => s + unit.x, 0) / squad.count;
          squad.y = squad.units.reduce((s, unit) => s + unit.y, 0) / squad.count;
          // Средний процент HP в отряде
          squad.hp = squad.units.reduce((s, unit) => s + (unit.health / (unit.maxHealth || 100)), 0) / squad.count;
          added = true;
          break;
        }
      }
    }
    
    // Если отряд не найден, создаём новый
    if (!added) {
      squads.push({
        baseType: u.type,
        type: u.type + "_squad", // Специальный тип для графа
        owner: u.owner,
        units: [u],
        count: 1,
        x: u.x,
        y: u.y,
        hp: u.health / (u.maxHealth || 100),
        commandQueue: u.commandQueue || [] // Наследуем команду лидера
      });
    }
  }
  return squads;
},

buildGraphState: function () {
  if (!gameState || !aiBase || !aiBase.maxHealth || aiBase.maxHealth <= 0 || aiBase.health < 0) return null;

  const now = performance.now();
  const raw = [{ obj: aiBase, type: "base", owner: "ai", x: aiBase.x, y: aiBase.y, hp: Math.min(1, aiBase.health / aiBase.maxHealth), valid: 1, freshness: 1.0, isStale: false }];
  const candidates = [];
  const newlySeen = new Set();

  // ==========================================
  // ШАГ 1: Собираем "Источники Зрения" (Туман войны)
  // ==========================================
  const visionSources = [];
  for (const b of gameState.buildings) {
    if (b.owner === "ai" && b.health > 0) {
      let r = 300;
      if (b.type.startsWith("turret")) r = b.visionRadius || b.range || 400;
      else if (b.type.includes("base")) r = 400;
      else if (b.type === "beacon") r = 350;
      else if (b.type === "barracks") r = 320;
      else if (b.type === "warehouse") r = 250;
      visionSources.push({ x: b.x, y: b.y, r: r });
    }
  }
  for (const u of gameState.units) {
    if (u.owner === "ai" && u.health > 0) {
      let r = 350;
      if (u.type === "worker") r = 200;
      else if (u.type === "fighter") r = 300;
      else if (u.type === "assault") r = 350;
      else if (u.type === "elite") r = 400;
      visionSources.push({ x: u.x, y: u.y, r: r });
    }
  }

  const isVisible = (x, y) => {
    for (let i = 0; i < visionSources.length; i++) {
      const v = visionSources[i];
      if (Math.abs(x - v.x) <= v.r && Math.abs(y - v.y) <= v.r) {
        if (Math.hypot(x - v.x, y - v.y) <= v.r) return true;
      }
    }
    return false;
  };

  // ==========================================
  // ШАГ 2: Фильтруем кандидатов через туман войны и обновляем память
  // ==========================================
  try {
    // 2A. Юниты (с кластеризацией в отряды!)
    // Собираем всех юнитов для кластеризации
    const allUnitsForClustering = [];
    for (const u of gameState.units) {
      if (!u || u.health <= 0 || !isFinite(u.x) || !isFinite(u.y)) continue;
      allUnitsForClustering.push(u);
    }

    // Кластеризуем их в отряды
    const squads = this.clusterUnits(allUnitsForClustering, 150); // 150px радиус объединения

    for (const squad of squads) {
      const memKey = `squad_${squad.baseType}_${squad.owner}_${Math.round(squad.x)}_${Math.round(squad.y)}`;
      const isVisibleNow = isVisible(squad.x, squad.y);

      // 🔥 СВОИ ОТРЯДЫ: видим всегда
      if (squad.owner === "ai" && ["fighter", "assault", "elite"].includes(squad.baseType)) {
        candidates.push({ 
          obj: squad, type: squad.type, owner: squad.owner, 
          x: squad.x, y: squad.y, hp: squad.hp, 
          count: squad.count, // 🔥 ВАЖНО: количество юнитов
          valid: 1, freshness: 1.0, isStale: false 
        });
        this.reconMemory.set(memKey, { 
          obj: squad, type: squad.type, owner: squad.owner, 
          x: squad.x, y: squad.y, hp: squad.hp, count: squad.count,
          lastSeen: now, isStale: false, isBuilding: false 
        });
        continue;
      }

      // 🔥 ВРАЖЕСКИЕ ОТРЯДЫ: видим или помним
      if (squad.owner !== "ai" && ["fighter", "assault", "elite"].includes(squad.baseType)) {
        if (isVisibleNow) {
          newlySeen.add(memKey);
          this.reconMemory.set(memKey, { 
            obj: squad, type: squad.type, owner: squad.owner, 
            x: squad.x, y: squad.y, hp: squad.hp, count: squad.count,
            lastSeen: now, isStale: false, isBuilding: false 
          });
          candidates.push({ 
            obj: squad, type: squad.type, owner: squad.owner, 
            x: squad.x, y: squad.y, hp: squad.hp, 
            count: squad.count, valid: 1, freshness: 1.0, isStale: false 
          });
        }
      }
    }

    // 2B. Здания
    for (const b of gameState.buildings) {
      if (!b || b.health <= 0 || b === aiBase || !isFinite(b.x) || !isFinite(b.y)) continue;
      const memKey = `building_${b.type}_${b.id}`;
      const isVisibleNow = isVisible(b.x, b.y);

      if (b.owner === "ai") {
        candidates.push({ obj: b, type: b.type, owner: b.owner, x: b.x, y: b.y, hp: b.health / (b.maxHealth || 1), valid: 1, freshness: 1.0, isStale: false });
        this.reconMemory.set(memKey, { obj: b, type: b.type, owner: b.owner, x: b.x, y: b.y, hp: b.health / (b.maxHealth || 1), lastSeen: now, isStale: false, isBuilding: true });
      } else {
        if (isVisibleNow) {
          newlySeen.add(memKey);
          this.reconMemory.set(memKey, { obj: b, type: b.type, owner: b.owner, x: b.x, y: b.y, hp: b.health / (b.maxHealth || 1), lastSeen: now, isStale: false, isBuilding: true });
          candidates.push({ obj: b, type: b.type, owner: b.owner, x: b.x, y: b.y, hp: b.health / (b.maxHealth || 1), valid: 1, freshness: 1.0, isStale: false });
        }
      }
    }

    // 2C. Ресурсы
    for (const r of gameState.resources) {
      if (!r || r.amount <= 0) continue;
      const memKey = `resource_${r.type}_${Math.round(r.x)}_${Math.round(r.y)}`;
      const isVisibleNow = isVisible(r.x, r.y);
      if (isVisibleNow) {
        newlySeen.add(memKey);
        this.reconMemory.set(memKey, { obj: r, type: r.type, owner: "neutral", x: r.x, y: r.y, hp: r.amount / (r.max || 1), lastSeen: now, isStale: false, isBuilding: false });
        candidates.push({ obj: r, type: r.type, owner: "neutral", x: r.x, y: r.y, hp: r.amount / (r.max || 1), valid: 1, freshness: 1.0, isStale: false });
      }
    }
  } catch (e) { return null; }

  // ==========================================
  // ШАГ 3: Добавляем "stale" узлы из памяти
  // ==========================================
  const staleCandidates = [];
  for (const [key, mem] of this.reconMemory.entries()) {
    if (newlySeen.has(key)) continue;
    const age = now - mem.lastSeen;

    let maxAge = this.MAX_MEMORY_AGE || 60000;
    if (mem.isBuilding) maxAge = 90000;
    if (mem.type && mem.type.startsWith("turret")) maxAge = 120000;
    if (mem.owner === "player" && ["fighter", "assault", "elite"].includes(mem.type)) maxAge = 25000;

    if (age > maxAge) {
      this.reconMemory.delete(key);
      continue;
    }
    if (mem.obj && mem.obj.health !== undefined && mem.obj.health <= 0) {
      this.reconMemory.delete(key);
      continue;
    }

    const freshness = Math.max(0.1, 1.0 - (age / maxAge));
    staleCandidates.push({
      obj: mem.obj, type: mem.type, owner: mem.owner, x: mem.x, y: mem.y, hp: mem.hp,
      valid: 1, freshness: freshness, isStale: true, lastSeen: mem.lastSeen, isBuilding: mem.isBuilding || false
    });
  }

  staleCandidates.sort((a, b) => {
    let aP = 0, bP = 0;
    if (a.owner === "player") aP += 1000;
    if (b.owner === "player") bP += 1000;
    if (a.type && a.type.startsWith("turret")) aP += 800;
    if (b.type && b.type.startsWith("turret")) bP += 800;
    if (a.isBuilding) aP += 400;
    if (b.isBuilding) bP += 400;
    if (["fighter", "assault", "elite", "base", "barracks", "warehouse"].includes(a.type)) aP += 300;
    if (["fighter", "assault", "elite", "base", "barracks", "warehouse"].includes(b.type)) bP += 300;
    aP += a.freshness * 100;
    bP += b.freshness * 100;
    return bP - aP;
  });

  candidates.push(...staleCandidates.slice(0, 20));

  // ==========================================
  // ШАГ 4: Скоринг и заполнение графа
  // ==========================================
  const scoreObj = (o) => {
    let s = 10000;
    if (o.owner === "player") s += 5000;
    if (o.owner === "ai") s += 2500;
    if (["fighter", "assault", "elite"].includes(o.type)) {
      s += 3000;
      if (o.owner === "ai" && o.obj && o.obj.commandQueue && o.obj.commandQueue.length > 0) s += 2000;
    }
    if (o.type?.startsWith("turret")) s += 1600;
    if (["base", "base2", "base3", "barracks", "barracks2", "barracks3", "warehouse", "repairWorkshop", "beacon"].includes(o.type)) s += 1200;
    if (["gold", "silicon", "plasma"].includes(o.type)) s += 800 + (o.hp || 0) * 800;
    if (o.freshness !== undefined) s += o.freshness * 500;
    return s;
  };

  candidates.sort((a, b) => scoreObj(b) - scoreObj(a));

  for (const o of candidates.slice(0, CFG.MAX_NODES - 1)) {
    raw.push({
      obj: o.obj, type: o.type || "unknown", owner: o.owner || "none", x: o.x, y: o.y,
      hp: o.hp || 0, valid: 1, freshness: o.freshness !== undefined ? o.freshness : 1.0, isStale: o.isStale || false
    });
  }

  // 🔥 ВИРТУАЛЬНЫЕ УЗЛЫ: зоны угроз, фланги, разведка
  if (typeof this.generateVirtualNodes === "function") {
    const virtualNodes = this.generateVirtualNodes(raw);
    for (let i = 0; i < virtualNodes.length && raw.length < CFG.MAX_NODES - 4; i++) {
      raw.push(virtualNodes[i]);
    }
  }

  while (raw.length < CFG.MAX_NODES) {
    raw.push({ obj: null, type: "pad", owner: "none", x: 0, y: 0, hp: 0, valid: 0, freshness: 0, isStale: false });
  }

  const X = raw.map(n => this.nodeFeatures(n));
  const A_distance = [];
  const A_threat = [];

  for (let i = 0; i < CFG.MAX_NODES; i++) {
    const row_dist = [];
    const row_threat = [];
    const ni = raw[i];

    for (let j = 0; j < CFG.MAX_NODES; j++) {
      const nj = raw[j];
      if (!ni.valid || !nj.valid) { row_dist.push(0); row_threat.push(0); continue; }
      if (i === j) { row_dist.push(1); row_threat.push(1); continue; }

      const d = Math.hypot(ni.x - nj.x, ni.y - nj.y);

      let geoConnection = 0;
      if (d <= CFG.INTERACTION_RADIUS) {
        geoConnection = Math.exp(-d / CFG.INTERACTION_RADIUS);
      }

      // === СЕМАНТИЧЕСКИЕ СВЯЗИ (логические) — ПОЛНЫЙ ОРИГИНАЛЬНЫЙ БЛОК БЕЗ СОКРАЩЕНИЙ ===
      let semanticConnection = 0;
      
      // 1. ЛОГИСТИЧЕСКИЕ СВЯЗИ (склады ↔ ресурсы)
      if (ni.type === "warehouse" && ["gold", "silicon", "plasma"].includes(nj.type)) {
        const maxResDist = 400;
        if (d < maxResDist) semanticConnection = Math.max(semanticConnection, 0.9 * (1 - d / maxResDist));
      }
      if (nj.type === "warehouse" && ["gold", "silicon", "plasma"].includes(ni.type)) {
        const maxResDist = 400;
        if (d < maxResDist) semanticConnection = Math.max(semanticConnection, 0.9 * (1 - d / maxResDist));
      }

      // 2. РАБОЧИЕ ↔ СКЛАДЫ
      if (ni.type === "warehouse" && nj.type === "worker") semanticConnection = Math.max(semanticConnection, 0.85);
      if (nj.type === "warehouse" && ni.type === "worker") semanticConnection = Math.max(semanticConnection, 0.85);

      // 3. РЕМОНТНЫЕ СВЯЗИ (мастерские ↔ поврежденные объекты < 90% HP)
      if (ni.type === "repairWorkshop" && nj.obj && nj.hp < 0.9) {
        const maxRepairDist = 350;
        if (d < maxRepairDist) {
          const damageFactor = 1 - nj.hp;
          semanticConnection = Math.max(semanticConnection, 0.8 * damageFactor * (1 - d / maxRepairDist));
        }
      }
      if (nj.type === "repairWorkshop" && ni.obj && ni.hp < 0.9) {
        const maxRepairDist = 350;
        if (d < maxRepairDist) {
          const damageFactor = 1 - ni.hp;
          semanticConnection = Math.max(semanticConnection, 0.8 * damageFactor * (1 - d / maxRepairDist));
        }
      }

      // 4. РЕМОНТНИКИ ↔ МАСТЕРСКИЕ
      if (ni.type === "repairWorkshop" && nj.type === "repairman") semanticConnection = Math.max(semanticConnection, 0.9);
      if (nj.type === "repairWorkshop" && ni.type === "repairman") semanticConnection = Math.max(semanticConnection, 0.9);

      // 5. ПРОИЗВОДСТВЕННЫЕ СВЯЗИ (казармы → юниты)
      const productionLinks = {
        "barracks": ["fighter"],
        "barracks2": ["assault", "fighter"],
        "barracks3": ["elite", "assault", "fighter"],
        "warehouse": ["worker"],
        "repairWorkshop": ["repairman"]
      };
      if (productionLinks[ni.type] && productionLinks[ni.type].includes(nj.type)) semanticConnection = Math.max(semanticConnection, 0.95);
      if (productionLinks[nj.type] && productionLinks[nj.type].includes(ni.type)) semanticConnection = Math.max(semanticConnection, 0.95);

      // 6. ОБОРОНИТЕЛЬНЫЕ СВЯЗИ (турели ↔ защищаемые объекты)
      const turretRanges = { "turret": 250, "turret2": 500, "turret3": 450 };
      if (turretRanges[ni.type]) {
        const range = turretRanges[ni.type];
        if (d < range && !nj.type.startsWith("turret")) {
          let importance = 0.5;
          if (nj.type.includes("base")) importance = 1.0;
          else if (nj.type.includes("barracks")) importance = 0.8;
          else if (nj.type === "warehouse") importance = 0.7;
          semanticConnection = Math.max(semanticConnection, importance * (1 - d / range));
        }
      }
      if (turretRanges[nj.type]) {
        const range = turretRanges[nj.type];
        if (d < range && !ni.type.startsWith("turret")) {
          let importance = 0.5;
          if (ni.type.includes("base")) importance = 1.0;
          else if (ni.type.includes("barracks")) importance = 0.8;
          else if (ni.type === "warehouse") importance = 0.7;
          semanticConnection = Math.max(semanticConnection, importance * (1 - d / range));
        }
      }

      // 7. СТРАТЕГИЧЕСКИЕ СВЯЗИ (маяки ↔ расширение)
      if ((ni.type === "beacon" || nj.type === "beacon")) {
        const beaconRange = 300;
        if (d < beaconRange && (ni.type.includes("base") || nj.type.includes("base") || ni.type === "beacon" || nj.type === "beacon")) {
          semanticConnection = Math.max(semanticConnection, 0.7 * (1 - d / beaconRange));
        }
      }

      // 8. ИЕРАРХИЧЕСКИЕ СВЯЗИ (базы ↔ все здания)
      if ((ni.type.includes("base") || nj.type.includes("base"))) {
        if ((ni.type.includes("base") && !nj.type.includes("base")) || (nj.type.includes("base") && !ni.type.includes("base"))) {
          const baseRange = 500;
          if (d < baseRange) semanticConnection = Math.max(semanticConnection, 0.6 * (1 - d / baseRange));
        }
      }

      // 9. БОЕВЫЕ ЮНИТЫ ↔ ИХ ЦЕЛИ (атака)
      if ((ni.type === "fighter" || ni.type === "assault" || ni.type === "elite") && nj.owner !== ni.owner) {
        if (nj.obj && nj.obj.commandQueue && nj.obj.commandQueue.length > 0) {
          const targetCmd = nj.obj.commandQueue.find(cmd => cmd.type === "attack");
          if (targetCmd && targetCmd.target === ni.obj) semanticConnection = Math.max(semanticConnection, 0.9);
        }
      }
      // === КОНЕЦ БЛОКА СЕМАНТИЧЕСКИХ СВЯЗЕЙ ===

      const finalConnection = Math.max(geoConnection, semanticConnection);
      row_dist.push(finalConnection);

      let threatValue = 0;
      if (ni.owner === "player" && nj.owner === "ai") {
        const enemyDps = this.getUnitDps(ni.type) || 0;
        if (d < 300) threatValue = (enemyDps / 100) * Math.exp(-d / 200);
      } else if (ni.owner === "ai" && nj.owner === "ai") {
        if (d < 200) threatValue = 0.5 * Math.exp(-d / 150);
      } else if (ni.owner === "ai" && nj.owner === "player") {
        const myDps = this.getUnitDps(ni.type) || 0;
        if (d < 250) threatValue = (myDps / 100) * Math.exp(-d / 200);
      }
      row_threat.push(Math.min(1, threatValue));
    }

    const sum_dist = row_dist.reduce((a, b) => a + b, 0) + 1e-9;
    const sum_threat = row_threat.reduce((a, b) => a + b, 0) + 1e-9;
    A_distance.push(row_dist.map(v => v / sum_dist));
    A_threat.push(row_threat.map(v => v / sum_threat));
  }

  return { X, A_distance, A_threat, nodes: raw };
},

    assessThreats: function () {
      const enemyUnits = gameState.units.filter(u => u.owner === "player" && u.health > 0);
      const enemyBuildings = gameState.buildings.filter(b => b.owner === "player" && b.health > 0);
      const composition = {};
      enemyUnits.forEach(u => { composition[u.type] = (composition[u.type] || 0) + 1; });
      let threatLevel = 0;
      enemyUnits.forEach(u => { threatLevel += THREAT_ASSESSMENT[u.type] || 1; });
      enemyBuildings.filter(b => b.type?.startsWith("turret")).forEach(t => {
        const dist = Math.hypot(t.x - aiBase.x, t.y - aiBase.y);
        if (dist < 600) threatLevel += (THREAT_ASSESSMENT[t.type] || 2) * 2;
      });
      this.strategicMemory.enemyComposition = composition;
      this.strategicMemory.threatLevel = threatLevel;
    },

    // 🔥 РАЗДЕЛЕНИЕ АРМИИ НА ГРУППЫ ДЛЯ ФЛАНГОВОЙ АТАКИ
splitArmyIntoGroups: function(freeUnits, numGroups = 2) {
  if (freeUnits.length <= numGroups) {
    // Если юнитов мало, каждая группа = 1 юнит
    return freeUnits.map(u => [u]);
  }
  
  // Сортируем юнитов по позиции (слева направо)
  const sorted = [...freeUnits].sort((a, b) => a.x - b.x);
  
  // Распределяем по группам равномерно
  const groups = Array.from({ length: numGroups }, () => []);
  sorted.forEach((unit, idx) => {
    groups[idx % numGroups].push(unit);
  });
  
  return groups;
},

decide: function () {
const state = this.buildGraphState();
if (!state) return;
const now = performance.now();
 const pred = this.predictData(state);
 if (!pred) return;
 const logitsData = pred.logits;
 const mask = this.validActionMask();
 const temperature = this.bcActive ? 1.5 : 1.0;    
 let chosenIndex = this.sampleMasked(logitsData, mask, temperature);
 
 // 🔥 ВАЖНО: объявляем переменные ОДИН РАЗ через let (чтобы можно было переприсваивать)
 let proposedAction = G_ACTIONS[chosenIndex];
 let finalActionIndex = chosenIndex;
 let finalAction = proposedAction;

 // 🔥 МЯГКОЕ ПОДАВЛЕНИЕ через logits вместо жёсткой блокировки
 const tacticalIndices = ["tactic_all_in","tactic_harass","tactic_push","tactic_defend"]
     .map(a => AIDX[a]).filter(i => i !== undefined);

 // Считаем "давление занятости" армии
 const busyUnits = gameState.units.filter(u =>
     u.owner === "ai" && ["fighter","assault","elite"].includes(u.type) &&
     u.health > 0 && u.missionLog
 ).length;
 const totalArmy = gameState.units.filter(u =>
     u.owner === "ai" && ["fighter","assault","elite"].includes(u.type) && u.health > 0
 ).length;
 const busyRatio = totalArmy > 0 ? busyUnits / totalArmy : 0;

 // Если армия занята — подавляем тактические действия в logits (но не блокируем!)
 if (busyRatio > 0.5) {
     const suppressLogits = logitsData.slice();
     for (const idx of tacticalIndices) {
         suppressLogits[idx] -= 2.0 * busyRatio;
     }
     // Повторный выбор той же стратегии тоже подавляем
     if (this.lastStrategicAction) {
         const lastIdx = AIDX[this.lastStrategicAction];
         if (lastIdx !== undefined) {
             const timeSince = now - (this.lastStrategicChangeTime || 0);
             if (timeSince < (CFG.MIN_COMMIT_MS || 5000)) {
                 suppressLogits[lastIdx] -= 1.5;
             }
         }
     }
     chosenIndex = this.sampleMasked(suppressLogits, mask, temperature);
     
     // 🔥 ПЕРЕПРИСВАИВАЕМ (не объявляем заново!)
     proposedAction = G_ACTIONS[chosenIndex];
     finalActionIndex = chosenIndex;
     finalAction = proposedAction;
 }

 // Запоминаем стратегическое действие (без принудительного возврата)
 const isStrategic = ["tactic_all_in","tactic_harass","tactic_push","tactic_defend","build_base2","build_barracks"].includes(proposedAction);
 if (isStrategic) {
     this.lastStrategicChangeTime = now;
     this.lastStrategicAction = proposedAction;
 }

 const metrics = this.metrics();
 const executed = this.execute(finalAction, finalActionIndex, state);
   if (!executed) {
       console.warn(`[DEBUG AI] ⚠️ Действие '${finalAction}' ЗАПРОШЕНО, но НЕ ВЫПОЛНЕНО! Ресурсы:`, JSON.stringify(gameState.aiResources));
   } else {
       console.log(`[DEBUG AI] ✅ Действие '${finalAction}' успешно выполнено.`);
   }
 this.pending.push({ 
   time: now, 
   state: { X: state.X, A_distance: state.A_distance, A_threat: state.A_threat }, 
   action: finalAction, 
   actionIndex: finalActionIndex, 
   executed: !!executed, 
   executedType: typeof executed === 'string' ? executed : null,
   before: metrics,
   logProb: 0, 
   value: 0
 });
 if (this.pending.length > 30) this.pending.shift();
 this.lastState = state;
 this.lastAction = finalAction;
},

evaluatePending: function (now) {
  if (!this.pending.length) return;
  const current = this.metrics();
  const keep = [];
  
  for (const p of this.pending) {
    // 🔥 НЕТ ТАЙМЕРОВ! Резолвим по событиям через missionCache
    // pending — это только для "сырых" действий без миссии
    const missionEntry = this.missionCache.find(m => m.action === p.action && !m.resolved);
    
    if (missionEntry) {
      // Миссия ещё не разрешилась — ждём событий, НЕ таймера
      keep.push(p);
      continue;
    }
    
    // Миссии нет в кеше (например, idle, hire) — резолвим сразу
    const reward = this.reward(p, current);
    if (Math.abs(reward) > 0.1) {
      this.replay.push({ 
        X: p.state.X, A_distance: p.state.A_distance, A_threat: p.state.A_threat, 
        actionIndex: p.actionIndex, reward 
      });
    }
    // НЕ добавляем в keep — удаляем
  }
  this.pending = keep;
},

    reward: function (p, after) {
      if (!after.playerAlive) return 500.0; 
      if (after.baseHp <= 0) return -500.0; 
      
      const beforeHp = p.before && typeof p.before.baseHp === 'number' ? p.before.baseHp : 1.0;
      const currentHp = typeof after.baseHp === 'number' ? after.baseHp : 0;
      
      const delta = (currentHp - beforeHp) * 20.0;
      return isFinite(delta) ? delta : 0.0; 
    },

trainBatch: function () {
  // 🔥 Блокируем запуск, если уже идет обучение, сохранение или мало данных
  if (this.training || this.isSaving || this.replay.length < CFG.BATCH_SIZE) return;
  this.training = true;

  const batch = [];
  for (let i = 0; i < CFG.BATCH_SIZE; i++) {
    const sample = this.replay.getRandom();
    if (!sample) continue;
    
    // 🔥 Проверка валидности (поддерживает и плоский, и 2D массив)
    const isXValid = sample.X && (
      (Array.isArray(sample.X) && sample.X.length === CFG.MAX_NODES * CFG.NODE_FEATURES) ||
      (Array.isArray(sample.X) && Array.isArray(sample.X[0]) && sample.X.length === CFG.MAX_NODES && sample.X[0].length === CFG.NODE_FEATURES)
    );
    const isDistValid = sample.A_distance && Array.isArray(sample.A_distance) && sample.A_distance.length === CFG.MAX_NODES;
    
    if (isXValid && isDistValid && isFinite(sample.reward)) {
      batch.push(sample);
    }
  }

  if (batch.length < 4) {
    this.training = false;
    return;
  }

  // 🔥 КРИТИЧЕСКИЙ ФИКС №1: ДОБИВАЕМ БАТЧ ДО КОНСТАНТНОГО РАЗМЕРА
  // Это гарантирует, что форма тензоров ВСЕГДА одинаковая, и TF.js переиспользует одни и те же текстуры.
  while (batch.length < CFG.BATCH_SIZE) {
    batch.push(batch[Math.floor(Math.random() * batch.length)]);
  }
  
  const B = CFG.BATCH_SIZE; // 🔥 КРИТИЧЕСКИЙ ФИКС №2: ТЕПЕРЬ B ВСЕГДА КОНСТАНТА (например, 64)
  const shouldSave = (this.trainBatches + 1) % CFG.SAVE_EVERY_BATCHES === 0;

  // 🔥 ОДИН ЕДИНСТВЕННЫЙ tf.tidy для всего обучения
  tf.tidy(() => {
    try {
      const xs = tf.tensor3d(batch.map(b => b.X), [B, CFG.MAX_NODES, CFG.NODE_FEATURES]);
      const as_dist = tf.tensor3d(batch.map(b => b.A_distance), [B, CFG.MAX_NODES, CFG.MAX_NODES]); 
      const as_threat = tf.tensor3d(batch.map(b => b.A_threat), [B, CFG.MAX_NODES, CFG.MAX_NODES]); 
      const act = tf.tensor1d(batch.map(b => b.actionIndex), "int32"); 
      const oldLogProbs = tf.tensor1d(batch.map(b => isFinite(b.oldLogProb) ? b.oldLogProb : -10.0), "float32");
      const oldValues = tf.tensor1d(batch.map(b => isFinite(b.value) ? b.value : 0.0), "float32");
      
      const rewardsRaw = batch.map(b => {
        const r = isFinite(b.reward) ? Math.max(-1000, Math.min(1000, b.reward)) : 0;
        return Math.tanh(r / 100) * 10;
      });      const meanR = rewardsRaw.reduce((a,b)=>a+b,0) / B;
      const variance = rewardsRaw.reduce((a, b) => a + (b - meanR) ** 2, 0) / B;
      const stdR = Math.sqrt(variance) + 1e-6;
      const rew = tf.tensor1d(rewardsRaw.map(r => (r - meanR) / stdR), "float32");    
      
      const masks = batch.map(b => {
        let m = b.actionMask;
        if (!m || m.length !== G_ACTIONS.length) m = new Array(G_ACTIONS.length).fill(1);
        return m;
      });
      const maskTensor = tf.tensor2d(masks, [B, G_ACTIONS.length]);
      const globalFeatures = this.getGlobalFeatures().map(v => isFinite(v) ? v : 0);
      const globalBatch = tf.tensor2d(Array(B).fill(globalFeatures), [B, CFG.GLOBAL_FEATURES]);
      
      const { value, grads } = tf.variableGrads(() => {
        const { logits, value } = this.model.forwardBatch(xs, as_dist, as_threat, globalBatch);  
        const clippedValue = tf.clipByValue(value, -50, 50);
        const bcRatio = Math.max(0, 1 - (this.trainBatches / CFG.BC_TRANSITION_BATCHES));
        const inverseMask = maskTensor.sub(1).mul(-1e9); 
        const maskedLogits = logits.add(inverseMask);
        const logProbs = tf.log(tf.softmax(maskedLogits).add(1e-10));      
        const oneHot = tf.oneHot(act, G_ACTIONS.length);
        const newLogProbs = logProbs.mul(oneHot).sum(1);       
        const values = clippedValue.squeeze();
        const advantage = rew.sub(values);        
        const ratio = tf.exp(newLogProbs.sub(oldLogProbs));
        const clippedRatio = tf.clipByValue(ratio, 1 - CFG.CLIP_EPSILON, 1 + CFG.CLIP_EPSILON);        
        const surrogate1 = ratio.mul(advantage);
        const surrogate2 = clippedRatio.mul(advantage);
        const actorLoss = tf.minimum(surrogate1, surrogate2).mul(-1).mean();           
        const valueClipped = oldValues.add(tf.clipByValue(values.sub(oldValues), -0.5, 0.5));
        const criticLoss1 = values.sub(rew).square();
        const criticLoss2 = valueClipped.sub(rew).square();
        const criticLoss = tf.maximum(criticLoss1, criticLoss2).mean();    
        const probs = tf.softmax(maskedLogits);
        const entropy = probs.mul(logProbs).mul(-1).sum(1).mean();
        let totalLoss;
        const hasExpertData = batch.some(b => b.isExpert);
        if (bcRatio > 0.1 || hasExpertData) {
            const bcLoss = logProbs.mul(oneHot).sum(1).mul(-1).mean();
            const expertWeight = hasExpertData ? 2.0 : 1.0;
            totalLoss = bcLoss.mul(bcRatio * expertWeight).add(actorLoss.mul(1 - bcRatio)).add(criticLoss.mul(0.5));
        } else {
            if (this.bcActive) {
                console.log("[GnnAI] 🎓 BC завершен. Full PPO mode.");
                this.bcActive = false;
            }
        // 🔥 Динамическая энтропия вместо статичной константы
        const currentEntropyCoef = this.getEntropyCoef();
        totalLoss = actorLoss.add(criticLoss.mul(0.5)).sub(entropy.mul(currentEntropyCoef));        }
        return totalLoss;
      }, this.vars);

      // 🔥 БЕЗОПАСНЫЙ КЛИППИНГ ГРАДИЕНТОВ
      const gradValues = this.vars.map(v => grads[v.name]).filter(Boolean);
      let clipCoef = 1.0;
      if (gradValues.length > 0) {
        const sumSquares = gradValues.map(g => g.square().sum());
        const globalNorm = tf.addN(sumSquares).sqrt();
        const normVal = globalNorm.dataSync()[0];
        clipCoef = Math.min(1.0, CFG.GRADIENT_CLIP_NORM / (normVal + 1e-8));
        sumSquares.forEach(t => t.dispose()); // Чистим промежуточные тензоры
        globalNorm.dispose();
      }

      const finalGrads = {};
      this.vars.forEach(v => {
        const g = grads[v.name];
        if (g) {
          finalGrads[v.name] = g.mul(clipCoef);
        } else {
          finalGrads[v.name] = tf.zerosLike(v);
        }
      });

      this.optimizer.applyGradients(finalGrads);

      // 🔥 РУЧНАЯ ОЧИСТКА ВСЕХ ГРАДИЕНТОВ
      this.vars.forEach(v => {
        if (grads[v.name]) grads[v.name].dispose();
        if (finalGrads[v.name]) finalGrads[v.name].dispose();
      });

      const lossVal = value.dataSync()[0];
      value.dispose(); 
      
      if (!isFinite(lossVal)) {
        console.error("[GnnAI] ❌ Loss стал NaN! Сброс...");
        this.training = false;
        setTimeout(() => this.reset(), 0);
        return;
      }
      
      this.trainBatches++;
      if (this.trainBatches % 10 === 0) {
        const mem = tf.memory();
        console.log(`[GnnAI Train] Batch: ${this.trainBatches}, Loss: ${lossVal.toFixed(4)}, GPU: ${(mem.numBytes / 1024 / 1024).toFixed(1)} MB, Tensors: ${mem.numTensors}`);
      }
      this.updateTargetNetwork();
    } catch (e) {
      console.error("[GnnAI] train error", e);
    } finally {
      this.training = false;
    }
  });

  // 🔥 АСИНХРОННОЕ СОХРАНЕНИЕ ВНЕ tf.tidy
  if (shouldSave) {
    this.isSaving = true;
    requestAnimationFrame(() => {
      requestAnimationFrame(async () => {
        try {
          await this.saveWeights();
        } catch (e) {
          console.error("[GnnAI] save error:", e);
        } finally {
          this.isSaving = false;
        }
      });
    });
  } else {
    this.isSaving = false;
  }
},

    updateTargetNetwork: function () {
      if (!this.targetVars) return;
      tf.tidy(() => {
        for (let i = 0; i < this.vars.length; i++) {
          const v = this.vars[i];
          const tv = this.targetVars[i];
          const updated = v.mul(this.tau).add(tv.mul(1 - this.tau));
          tv.assign(updated);
        }
      }); 
    },
    
    getUnitDps: function(type) {
      const dps = { fighter: 15, assault: 35, elite: 60, turret: 20, turret2: 40, turret3: 70, worker: 0, repairman: 0 };
      return dps[type] || 0;
    },

    nodeFeatures: function (n) {
      if (!n || !n.valid) return new Array(CFG.NODE_FEATURES).fill(0);
      const t = n.type || "";
      const isBuilding = typeof Building !== "undefined" && n.obj instanceof Building;
      const isResource = ["gold","silicon","plasma"].includes(t);
      const isCombat = ["fighter","assault","elite"].includes(t);
      const isTurret = typeof t === "string" && t.startsWith("turret");
      
      const wW = CFG.WORLD_WIDTH || 2000;
      const wH = CFG.WORLD_HEIGHT || 2000;
      const relX = (n.x - aiBase.x) / (wW * 0.5); 
      const relY = (n.y - aiBase.y) / (wH * 0.5);
      const maxDist = Math.hypot(wW, wH);
      const dist = Math.hypot(n.x - aiBase.x, n.y - aiBase.y) / maxDist;
      const threat = n.owner === "player" ? (THREAT_ASSESSMENT[t] || 0) / 7 : 0;
      
      const isActive = n.obj && n.obj.active ? 1 : 0;
      const isUnderConstruction = n.obj && n.obj.builtAt && !n.obj.active ? 1 : 0;
      const isKeyBuilding = ["base","base2","base3","barracks","barracks2","barracks3","warehouse","beacon"].includes(t) ? 1 : 0;
      const isMilitary = isCombat || isTurret ? 1 : 0;
      const isEconomic = t === "warehouse" || t ==="repairWorkshop" ? 1 : 0;
      const isExpansion = t === "base2" || t ==="base3" || t ==="beacon" ? 1 : 0;
      const techLevel = t === "base3" || t ==="barracks3" || t ==="turret3" ? 3 : (t ==="base2" || t ==="barracks2" || t ==="turret2" ? 2 : 1);

      let isUnderAttack = 0;
      if (n.obj && n.obj.owner === "ai" && n.obj.health > 0) {
        const enemiesNearby = gameState.units.some(u => u.owner === "player" && u.health > 0 && Math.hypot(u.x - n.obj.x, u.y - n.obj.y) < 150);
        if (enemiesNearby) isUnderAttack = 1;
      }

      let isIdle = 0;
      if (n.obj && n.obj.owner === "ai" && isCombat) {
        if (!n.obj.commandQueue || n.obj.commandQueue.length === 0) isIdle = 1;
      }

      let logisticsScore = 0;
      if (t === "warehouse" && n.obj) {
        let minResDist = 9999;
        gameState.resources.forEach(r => {
          if (r.amount > 0) {
            const d = Math.hypot(r.x - n.obj.x, r.y - n.obj.y);
            if (d < minResDist) minResDist = d;
          }
        });
        logisticsScore = Math.max(0, 1.0 - (minResDist / 1000));
      }
    let buildingCategory = 0; // 0 = не здание
    if (isBuilding) {
        if (t === "warehouse") buildingCategory = 1;      // экономическое
        else if (t === "repairWorkshop") buildingCategory = 2;  // ремонтное
        else if (t === "beacon" || t ==="base2" || t ==="base3") buildingCategory = 3; // экспансионное
        else if (t.startsWith("turret")) buildingCategory = 4;  // оборонительное
        else if (t.startsWith("barracks")) buildingCategory = 5; // производственное
        else if (t === "base") buildingCategory = 6;      // главная база
    }
      let workersOnBuilding = 0;
      if (t === "warehouse" && n.obj) {
        workersOnBuilding = (n.obj.workers || 0) / (n.obj.maxDeliveryWorkers || 5);
      } else if (t === "repairWorkshop" && n.obj) {
        workersOnBuilding = (n.obj.repairman || 0) / (n.obj.capacity || 3);
      }
		let nearestEnemyDist = 1.0;   // нормализованное расстояние до ближайшего врага
		let enemyClusterNear = 0;     // есть ли скопление врагов рядом (1 = да)
		let ourClusterStrength = 0;   // сила нашего скопления рядом
		let hpRatio = n.hp || 0;      // % HP юнита
		let cooldownProgress = 1.0;   // 0 = только выстрелил, 1 = готов
		let hasTarget = 0;            // есть ли цель в commandQueue
		let targetIsBuilding = 0;     // цель — здание (важнее) или юнит
		let targetHP = 0;             // HP цели (низкий = добить!)
		let surrounded = 0;           // окружён ли врагами

		if (isCombat && n.obj) {
		  const u = n.obj;
		  hpRatio = u.health / (u.maxHealth || 1);
		  cooldownProgress = u.attackCooldownMax > 0 
			? 1.0 - (u.attackCooldown || 0) / u.attackCooldownMax 
			: 1.0;
		  // Ищем ближайшего врага и считаем скопления
		  let minED = 9999;
		  let enemiesNear = 0;
		  let alliesNear = 0;
		  let allyPower = 0;
		  let enemyPower = 0;

		  for (const other of gameState.units) {
			if (other === u || other.health <= 0) continue;
			const d = Math.hypot(other.x - u.x, other.y - u.y);
			if (d < 200) {
			  if (other.owner === "player") {
				enemiesNear++;
				enemyPower += other.health + (this.getUnitDps(other.type) || 0) * 5;
			  } else if (other.owner === "ai") {
				alliesNear++;
				allyPower += other.health + (this.getUnitDps(other.type) || 0) * 5;
			  }
			}
			if (other.owner === "player" && d < minED) minED = d;
		  }

		  nearestEnemyDist = Math.min(1, minED / 400);
		  enemyClusterNear = enemiesNear >= 3 ? 1 : 0;  // скопление = 3+ врагов
		  ourClusterStrength = Math.min(1, allyPower / 300);
		  surrounded = (enemiesNear > alliesNear && enemiesNear >= 2) ? 1 : 0;

		  if (u.commandQueue && u.commandQueue.length > 0) {
			hasTarget = 1;
			const cmd = u.commandQueue.find(c => c.type === "attack");
			if (cmd && cmd.target) {
			  targetIsBuilding = ["base","base2","base3","warehouse","barracks","beacon","turret","turret2","turret3"].includes(cmd.target.type) ? 1 : 0;
			  targetHP = cmd.target.health / (cmd.target.maxHealth || 1);
			}
		  }
		}

		let targetPriority = 0;
		if (n.owner === "player" && n.type !=="gold" && n.type !=="silicon" && n.type !=="plasma") {
		  if (n.type === "base" || n.type ==="base2" || n.type ==="base3") targetPriority = 1.0;
		  else if (n.type === "warehouse") targetPriority = 0.85;
		  else if (n.type === "barracks" || n.type ==="barracks2" || n.type ==="barracks3") targetPriority = 0.8;
		  else if (n.type === "repairWorkshop") targetPriority = 0.75;
		  else if (n.type === "beacon") targetPriority = 0.7;
		  else if (n.type.startsWith("turret")) targetPriority = 0.6;
		  else if (n.type === "worker") targetPriority = 0.5;
		  else if (n.type === "fighter") targetPriority = 0.3;
		  else if (n.type === "assault") targetPriority = 0.4;
		  else if (n.type === "elite") targetPriority = 0.45;
		}

    let missionProgress = 0;
    let missionStuck = 0;
    let missionHitByTurret = 0;
    let missionEfficiency = 0;
    if (isCombat && n.obj && n.obj.missionLog) {
      const ml = n.obj.missionLog;
      const targetStartHP = ml.targetStartHP || 1;
      missionProgress = Math.min(1, ml.damageDealt / targetStartHP);
      const elapsed = (performance.now() - ml.startTime) / 1000;
      missionStuck = (elapsed > 15 && ml.damageDealt < 10) ? 1 : 0;
      missionHitByTurret = ml.hitByTurret ? 1 : 0;
      missionEfficiency = Math.min(5, ml.damageDealt / Math.max(1, ml.damageTaken));
    }

    const freshness = n.freshness !== undefined ? n.freshness : 1.0;
    const isStale = n.isStale ? 1 : 0;
    
    // 🔥 НОВЫЕ ПРИЗНАКИ ДЛЯ ВИРТУАЛЬНЫХ УЗЛОВ (Фланги и точки сбора)
    // Нормализуем threatDensity: делим на 4 (максимум ~4 турели могут простреливать точку)
    const threatDensity = n.threatDensity !== undefined ? (n.threatDensity / 4) : 0;
    const isStagingArea = n.isStagingArea ? 1 : 0;

    return [
      n.valid ? 1 : 0, 
      n.owner === "ai" ? 1 : 0, 
      n.owner === "player" ? 1 : 0, 
      n.hp || 0,
      (n.count !== undefined ? (n.count / 10) : 0), // Кластеризация: количество юнитов в отряде
      relX, relY, dist, 
      isCombat ? 1 : 0, isBuilding ? 1 : 0, t === "worker" ? 1 : 0,
      t === "fighter" ? 1 : 0, t === "assault" ? 1 : 0, t === "elite" ? 1 : 0, t.startsWith("base") ? 1 : 0,
      isTurret ? 1 : 0, t === "warehouse" ? 1 : 0, t === "beacon" ? 1 : 0, isResource ? 1 : 0,
      isBuilding && (t === "warehouse" || t === "repairWorkshop") ? 1 : 0, t === "repairWorkshop" ? 1 : 0,
      threat, 
      n.obj?.range ? Math.min(1, n.obj.range / 500) : 0, 
      n.obj?.fireRate ? Math.min(1, 1000 / (n.obj.fireRate || 1)) : 0,
      this.strategicMemory.threatLevel / 30, isActive, isUnderConstruction, isKeyBuilding, isMilitary,
      isEconomic, isExpansion, techLevel / 3, isUnderAttack, isIdle, logisticsScore,
      (n.obj && n.obj.commandQueue && n.obj.commandQueue.length > 0) ? 1 : 0, 
      (n.obj && n.obj.attackCooldown !== undefined && n.obj.attackCooldownMax && n.obj.attackCooldownMax > 0) 
        ? 1.0 - (n.obj.attackCooldown / n.obj.attackCooldownMax) : 1.0, 
      workersOnBuilding, nearestEnemyDist, enemyClusterNear, ourClusterStrength, hpRatio,
      cooldownProgress, hasTarget, targetIsBuilding, targetHP,
      surrounded, targetPriority, // ✅ ДУБЛИКАТЫ УДАЛЕНЫ (было 2 раза)
      missionProgress, missionStuck, missionHitByTurret, missionEfficiency, 
      freshness, isStale, // ✅ Память разведки
      threatDensity,      // 🔥 НОВОЕ: плотность огня в этой точке (0 = безопасно, 1 = смертельно)
      isStagingArea       // 🔥 НОВОЕ: 1 если это точка сбора позади зоны поражения, 0 если путь обхода
    ].map(v => isFinite(v) ? v : 0);
  },

validActionMask: function () {
  const mask = new Array(G_ACTIONS.length).fill(0);
  const res = gameState.aiResources;
  if (!res) { mask[AIDX.idle] = 1; return mask; }
  const m = this.metrics();
  const can = (costObj) => {
    if (!costObj) return false;
    return (res.gold || 0) >= (costObj.gold || 0) && 
           (res.silicon || 0) >= (costObj.silicon || 0) && 
           (res.plasma || 0) >= (costObj.plasma || 0);
  };
  const getCount = (type) => {
    const built = gameState.buildings.filter(b => b.owner === "ai" && b.type === type && b.health > 0).length;
    const queued = (window.buildQueue || []).filter(q => q.type === type).length;
    return built + queued;
  };
  // 🔥 has() проверяет ТОЛЬКО реально построенные и активные здания (игнорирует очередь!)
  const has = (type) => gameState.buildings.some(b => b.owner === "ai" && b.type === type && b.active && b.health > 0);
  const warehouses  = getCount("warehouse");
  const workshops   = getCount("repairWorkshop");
  const barracks    = getCount("barracks");
  const base2       = getCount("base2");
  const barracks2   = getCount("barracks2");
  const base3       = getCount("base3");
  const barracks3   = getCount("barracks3");
  const beacons     = getCount("beacon");
  const woundedUnits = gameState.units.filter(u => u.owner === "ai" && u.health > 0 && u.health < u.maxHealth * 0.7).length;
  const totalWorkers = gameState.units.filter(u => u.owner === "ai" && u.type === "worker" && u.health > 0).length;
  const neededWorkers = warehouses * 3;
  const isEconomyStable = m.aiArmy >= 2 || warehouses < 3;
  mask[AIDX.idle] = 1;
  // ============================================
  // 🔥 УРОВЕНЬ 0: ЭКОНОМИКА (всегда доступна)
  // ============================================
  if (can(WAREHOUSE_COST) && isEconomyStable && totalWorkers >= neededWorkers) {
    mask[AIDX.build_warehouse] = 1;
  }
  const hasWarehouseWithSpace = gameState.buildings.some(b => 
    b.owner === "ai" && b.type === "warehouse" && b.active && (b.workers || 0) < (b.maxDeliveryWorkers || 5)
  );
  if (hasWarehouseWithSpace && can(WORKER_COST)) mask[AIDX.hireWorker] = 1;
  if (warehouses >= 1 && can(REPAIR_WORKSHOP_COST) && (workshops < 2 || woundedUnits > 3)) {
    mask[AIDX.build_repair] = 1;
  }
  const hasWorkshopWithSpace = gameState.buildings.some(b => 
    b.owner === "ai" && b.type === "repairWorkshop" && b.active && (b.repairman || 0) < (b.capacity || 3)
  );
  if (hasWorkshopWithSpace && can(REPAIRMAN_COST)) mask[AIDX.hireRepairman] = 1;
  // ============================================
  // 🔥 УРОВЕНЬ 1: СКЛАД + МАСТЕРСКАЯ → КАЗАРМА 1
  // ============================================
  const hasWarehouse = has("warehouse");
  const hasWorkshop = has("repairWorkshop");
  if (hasWarehouse && hasWorkshop && barracks === 0 && can(BARRACKS_COST)) {
    mask[AIDX.build_barracks] = 1;
  }
  // 🔥 КЛЮЧЕВОЙ МОМЕНТ: Турели, Маяки и База 2 открываются ТОЛЬКО если казарма УЖЕ ПОСТРОЕНА (active)
  const hasBarracksBuilt = has("barracks");
  if (hasBarracksBuilt) {
    // 1. Турель 1
    const activeTurrets = getCount("turret");
    const maxAllowedTurrets = (beacons + 1) * 3;
    if (activeTurrets < maxAllowedTurrets && can(TURRET_COST)) {
      mask[AIDX.build_turret1] = 1;
    }
    // 3. После постройки турели 1 открывается Маяк
    const hasTurret = has("turret");
    if (hasTurret && can(BEACON_COST)) {
      const orphan = gameState.buildings.some(b =>
        b.owner === "ai" && b.type === "beacon" && b.active &&
        !gameState.buildings.some(w => w.owner === "ai" && w.type === "warehouse" && Math.hypot(w.x - b.x, w.y - b.y) < 250)
      );
      const hasTarget = this.findBestResourceCluster() !== null;
      if (!orphan && hasTarget && beacons < 4) {
        mask[AIDX.build_beacon] = 1;
      }
    }
    // 2. После постройки казармы 1 открывается База 2
    if (base2 === 0 && can(BASE2_COST)) {
      mask[AIDX.build_base2] = 1;
    }
    // Найм бойцов 1 уровня
    if (can(FIGHTER_COST)) {
      mask[AIDX.hireFighter] = 1;
    }
  }

  // 🔥 УРОВЕНЬ 2: БАЗА 2 → КАЗАРМА 2 + ТУРЕЛЬ 2
  const hasBase2 = has("base2");
  if (hasBase2) {
    // 4. После постройки базы 2 открываются казарма 2 и турель 2
    if (barracks2 === 0 && can(BARRACKS2_COST)) {
      mask[AIDX.build_barracks2] = 1;
    }
    const activeTurrets2 = getCount("turret2");
    if (activeTurrets2 < (beacons + 1) * 2 && can(TURRET2_COST)) {
      mask[AIDX.build_turret2] = 1;
    }
    if (has("barracks2") && can(ASSAULT_COST)) {
      mask[AIDX.hireAssault] = 1;
    }
    
  }

// 🔥 УРОВЕНЬ 3: ТИР 3 (base3, barracks3, turret3, elite)
// 🔥 ИСПРАВЛЕНИЕ: Разрешаем Тир-3, если УЖЕ есть казарма2 и турель2, 
// даже если curriculumTier застрял из-за задержки проверки.
const hasBarracks2Built = has("barracks2");
const hasTurret2Built = has("turret2");

if (this.curriculumTier >= 3 || (hasBarracks2Built && hasTurret2Built)) {
  // 1. Постройка Base3 (если есть barracks2)
  if (hasBarracks2Built && base3 === 0 && can(BASE3_COST)) {
    mask[AIDX.build_base3] = 1;
  }
  
  const hasBase3 = has("base3");
  if (hasBase3) {
    // 2. Постройка Barracks3
    if (barracks3 === 0 && can(BARRACKS3_COST)) {
      mask[AIDX.build_barracks3] = 1;
    }
    
    // 3. Постройка Turret3
    const activeTurrets3 = getCount("turret3");
    if (activeTurrets3 < (beacons + 1) * 2 && can(TURRET3_COST)) {
      mask[AIDX.build_turret3] = 1;
    }
    
    // 4. Найм Elite (если есть barracks3)
    if (has("barracks3") && can(ELITE_COST)) {
      mask[AIDX.hireElite] = 1;
    }
  }
}

  // 🔥 ТАКТИКИ (доступны при наличии армии)
  const armySize = gameState.units.filter(u => 
    u.owner === "ai" && ["fighter","assault","elite"].includes(u.type) && u.health > 0
  ).length;
  if (armySize >= 2) {
    mask[AIDX.defend] = 1;
    mask[AIDX.strike_weak] = 1;
    mask[AIDX.focus_fire] = 1;
    mask[AIDX.retreat_regroup] = 1;
    mask[AIDX.flank_attack] = 1;
    mask[AIDX.harass_economy] = 1;
    mask[AIDX.all_in_base] = 1;
  }
  // Idle — только если нет других доступных действий
  const hasAnyAffordableAction = mask.some((v, i) => v === 1 && i !== AIDX.idle);
  mask[AIDX.idle] = hasAnyAffordableAction ? 0 : 1;
  return mask;
},

    sampleMasked: function (logits, mask, temperature = 1.0) {
      const maskedLogits = logits.map((v, i) => mask[i] === 1 ? v / temperature : -1e9);
      const maxLogit = Math.max(...maskedLogits);
      const expLogits = maskedLogits.map(v => Math.exp(v - maxLogit));
      const sumExp = expLogits.reduce((a, b) => a + b, 0) || 1;
      const probs = expLogits.map(v => v / sumExp);
      let r = Math.random();
      for (let i = 0; i < probs.length; i++) {
        r -= probs[i];
        if (r <= 0) return i;
      }
      return probs.length - 1;
    },

execute: function (action, actionIndex, state) {
    //console.log("🔥 ПРЯМОЕ УПРАВЛЕНИЕ GNN: Выполняю действие ->", action); // <-- ДОБАВИТЬ ЭТО

  const tacticalActions = ["strike_weak", "focus_fire", "retreat_regroup", "flank_attack",
                           "harass_economy", "all_in_base", "defend",
                           "tactic_all_in", "tactic_harass", "tactic_push", "tactic_defend"];
// 🔥 МЯГКИЙ КОНТРОЛЬ: штрафуем за спам, но НЕ блокируем
if (tacticalActions.includes(action)) {
    const busyUnits = gameState.units.filter(u =>
        u.owner === "ai" && ["fighter","assault","elite"].includes(u.type) &&
        u.health > 0 && u.missionLog
    );
    const totalArmy = gameState.units.filter(u =>
        u.owner === "ai" && ["fighter","assault","elite"].includes(u.type) && u.health > 0
    ).length;
    
    if (totalArmy > 0) {
        const busyRatio = busyUnits.length / totalArmy;
        
        // 📉 Штраф за спам: армия занята, а мы снова шлём тактику
        if (busyRatio > 0.5) {
            const spamPenalty = -15.0 * busyRatio;
            this.replay.push({
                X: state.X, A_distance: state.A_distance, A_threat: state.A_threat,
                actionIndex: actionIndex, reward: spamPenalty
            });
            console.warn(`[GnnAI] ⚠️ Спам-тактика '${action}': ${Math.round(busyRatio*100)}% армии занята → штраф ${spamPenalty.toFixed(2)}`);
            // НЕ return false — даём модели шанс, вдруг это оправдано
        }
        
        // 📉 Штраф за ПОВТОР той же тактики без результата
        const recentSame = this.missionCache.filter(m => 
            !m.resolved && m.action === action
        ).length;
        if (recentSame > 0) {
            const repeatPenalty = -15.0 * recentSame;
            this.replay.push({
                X: state.X, A_distance: state.A_distance, A_threat: state.A_threat,
                actionIndex: actionIndex, reward: repeatPenalty
            });
            console.warn(`[GnnAI] 🔁 Повтор '${action}' (${recentSame}x в полёте) → штраф ${repeatPenalty.toFixed(2)}`);
        }
    }
}

// 🔥 Разрешаем множественные атаки, но штрафуем за перегрузку
const activeAttacks = this.missionCache.filter(m => !m.resolved && m.intent.type === "attack").length;
if (action.startsWith("attack") && activeAttacks >= 3) {
    this.replay.push({
        X: state.X, A_distance: state.A_distance, A_threat: state.A_threat,
        actionIndex: actionIndex, reward: -5.5
    });
    console.warn(`[GnnAI] ⚠️ Уже ${activeAttacks} атак в полёте — мягкий штраф`);
    // НЕ return false — модель может решить, что 4-я атака нужна
}
  try {
    // 🔥 ВОССТАНОВЛЕНО: проверка именно на действие "defend"
    if (action === "defend") {
      const freeUnits = gameState.units.filter(u => u.owner === "ai" && ["fighter", "assault", "elite"].includes(u.type) && u.health > 0 && (!u.commandQueue || u.commandQueue.length === 0));
      if (freeUnits.length === 0) return false;
      const anchor = this.threatAnchor() || aiBase;
      const defenderIds = freeUnits.map(u => u.id);
      freeUnits.forEach(u => {
        u.defending = true;
        u.commandQueue = [{ type: "move", x: anchor.x + (Math.random() - 0.5) * 150, y: anchor.y + (Math.random() - 0.5) * 150 }];
      });
      this.registerAction(action, state, { type: "defend", anchor: anchor.id || "aiBase", units: defenderIds.length, unitIds: defenderIds }, actionIndex);
      return true;
    }
    if (action.startsWith("tactic_")) {
      const freeUnits = gameState.units.filter(u => 
        u.owner === "ai" && ["fighter", "assault", "elite"].includes(u.type) && 
        u.health > 0 && (!u.commandQueue || u.commandQueue.length === 0)
      );
      if (freeUnits.length === 0) {
         this.replay.push({ X: state.X, A_distance: state.A_distance, A_threat: state.A_threat, actionIndex: actionIndex, reward: -1.0 });
         return false;
      }
      let target = null;
      let forcePercentage = 0.5; 
      if (action === "tactic_all_in") {
        target = gameState.buildings.find(b => b.owner === "player" && b.type === "base"); 
        forcePercentage = 0.90; 
      } 
      else if (action === "tactic_harass") {
        const vulnerable = [...gameState.units.filter(u => u.owner === "player" && u.type === "worker"), 
                            ...gameState.buildings.filter(b => b.owner === "player" && (b.type === "warehouse" || b.type === "repairWorkshop"))];
        target = vulnerable.length > 0 ? vulnerable[0] : gameState.buildings.find(b => b.owner === "player" && b.type === "base");
        forcePercentage = 0.30; 
      } 
      else if (action === "tactic_push") {
        const enemies = [...gameState.units.filter(u => u.owner === "player" && u.health > 0), 
                         ...gameState.buildings.filter(b => b.owner === "player" && b.health > 0)];
        target = enemies.reduce((best, o) => Math.hypot(o.x - aiBase.x, o.y - aiBase.y) < Math.hypot(best.x - aiBase.x, best.y - aiBase.y) ? o : best);
        forcePercentage = 0.60;
      } 
      else if (action === "tactic_defend") {
        const threats = gameState.units.filter(u => u.owner === "player" && u.health > 0);
        target = threats.reduce((closest, u) => Math.hypot(u.x - aiBase.x, u.y - aiBase.y) < Math.hypot(closest.x - aiBase.x, closest.y - aiBase.y) ? u : closest, {x: aiBase.x, y: aiBase.y});
        forcePercentage = 0.80; 
      }
      if (!target) return false;
      freeUnits.sort((a, b) => {
         if (action === "tactic_harass") return (a.type === "fighter" ? -1 : 1); 
         return 0; 
      });
      const attackersCount = Math.max(1, Math.ceil(freeUnits.length * forcePercentage));
      const attackers = freeUnits.slice(0, attackersCount);
      const attackerIds = attackers.map(u => u.id);

      attackers.forEach(u => {
        // Если цель - это отряд (squad), берём первый юнит из него как физическую цель для движка
        const physicalTarget = (attackTarget.obj && attackTarget.obj.units) ? attackTarget.obj.units[0] : attackTarget.obj;
        
        u.commandQueue = [
          { type: "move", x: attackTarget.x, y: attackTarget.y }, // Летим в центр отряда
          { type: "attack", target: physicalTarget }          // Атакуем конкретного юнита из отряда
        ];
      });
      this.registerAction(action, state, { 
        type: "attack", 
        tactic: action,
        targetId: target.id || "ground", 
        targetType: target.type,
        units: attackersCount, 
        unitIds: attackerIds 
      }, actionIndex);
      return true;
    }
    if (action === "build_warehouse") return this.tryBuildSpecific("warehouse", WAREHOUSE_COST, action, actionIndex, state);
    if (action === "build_repair") return this.tryBuildSpecific("repairWorkshop", REPAIR_WORKSHOP_COST, action, actionIndex, state);
    if (action === "build_barracks") return this.tryBuildSpecific("barracks", BARRACKS_COST, action, actionIndex, state);
    if (action === "build_beacon") return this.tryBuildSpecific("beacon", BEACON_COST, action, actionIndex, state);
    // 🔥 ТУРЕЛИ (все три тира!
    if (action === "build_turret1") return this.tryBuildSpecific("turret", TURRET_COST, action, actionIndex, state);
    // 🔥 ТИР-2
    if (action === "build_base2")     return this.tryBuildSpecific("base2", BASE2_COST, action, actionIndex, state);
    if (action === "build_barracks2") return this.tryBuildSpecific("barracks2", BARRACKS2_COST, action, actionIndex, state);
    if (action === "build_turret2") return this.tryBuildSpecific("turret2", TURRET2_COST, action, actionIndex, state);
    // 🔥 ТИР-3
    if (action === "build_base3")     return this.tryBuildSpecific("base3", BASE3_COST, action, actionIndex, state);
    if (action === "build_barracks3") return this.tryBuildSpecific("barracks3", BARRACKS3_COST, action, actionIndex, state);
    if (action === "build_turret3") return this.tryBuildSpecific("turret3", TURRET3_COST, action, actionIndex, state);
    if (action === "hireWorker") {
      const w = gameState.buildings.find(b => b.owner === "ai" && b.type === "warehouse" && b.active && (b.workers || 0) < (b.maxDeliveryWorkers || 5));
      if (!w) return false;
      const res = gameState.aiResources;
      const cost = WORKER_COST;
      const canAfford = (res.gold || 0) >= (cost.gold || 0) && (res.silicon || 0) >= (cost.silicon || 0) && (res.plasma || 0) >= (cost.plasma || 0);
      if (!canAfford) return false;
      if (typeof aiHireWorker === "function") aiHireWorker(w);
      else {
        w.workers = (w.workers || 0) + 1;
        res.gold = Math.round((res.gold || 0) - (cost.gold || 0));
        res.silicon = Math.round((res.silicon || 0) - (cost.silicon || 0));
        res.plasma = Math.round((res.plasma || 0) - (cost.plasma || 0));
        if (typeof getUnitFromPool === "function" && typeof addUnit === "function") {
          const worker = getUnitFromPool("worker", "ai", w.x, w.y);
          worker.homeWarehouse = w;
          addUnit(worker);
        }
        if (typeof updateResourceUI === "function") updateResourceUI();
      }
      this.registerAction(action, state, { type: "hire", unitType: "worker" }, actionIndex);
      return true;
    }
    if (action === "hireRepairman") {
      const r = gameState.buildings.find(b => b.owner === "ai" && b.type === "repairWorkshop" && b.active && (b.repairman || 0) < (b.capacity || 3));
      if (!r) return false;
      const res = gameState.aiResources;
      const cost = REPAIRMAN_COST;
      const canAfford = (res.gold || 0) >= (cost.gold || 0) && (res.silicon || 0) >= (cost.silicon || 0) && (res.plasma || 0) >= (cost.plasma || 0);
      if (!canAfford) return false;
      if (typeof aiHireRepairMan === "function") aiHireRepairMan(r);
      else {
        r.repairman = (r.repairman || 0) + 1;
        res.gold = Math.round((res.gold || 0) - (cost.gold || 0));
        res.silicon = Math.round((res.silicon || 0) - (cost.silicon || 0));
        res.plasma = Math.round((res.plasma || 0) - (cost.plasma || 0));
        if (typeof getUnitFromPool === "function" && typeof addUnit === "function") {
          const repairman = getUnitFromPool("repairman", "ai", r.x, r.y);
          repairman.homeWorkshop = r;
          addUnit(repairman);
        }
        if (typeof updateResourceUI === "function") updateResourceUI();
      }
      this.registerAction(action, state, { type: "hire", unitType: "repairman" }, actionIndex);
      return true;
    }
    if (action === "hireFighter" || action === "hireAssault" || action === "hireElite") {
      const bType = action === "hireFighter" ? "barracks" : (action === "hireAssault" ? "barracks2" : "barracks3");
      const uType = action === "hireFighter" ? "fighter" : (action === "hireAssault" ? "assault" : "elite");
      const cost = action === "hireFighter" ? FIGHTER_COST : (action === "hireAssault" ? ASSAULT_COST : ELITE_COST);
      const hasRequiredBuilding = gameState.buildings.some(b => b.owner === "ai" && b.type === bType && b.health > 0 && b.active);
      if (hasRequiredBuilding && this.enqueueUnit(uType, bType, cost)) {
        this.registerAction(action, state, { type: "hire", unitType: uType }, actionIndex);
        return true;
      }
      this.replay.push({ X: state.X, A_distance: state.A_distance, A_threat: state.A_threat, actionIndex: actionIndex, reward: -2.0 });
      return false;
    }
    if (action === "idle") {
      this.registerAction(action, state, { type: "idle" }, actionIndex);
      return true;
    }
if (action === "strike_weak") {
  const targets = state.nodes.filter(n => n.valid && n.owner === "player" && ["warehouse", "barracks", "beacon", "base", "base2", "base3"].includes(n.type));
  
  targets.forEach(target => {
    const nearbyEnemies = state.nodes.filter(n => n.valid && n.owner === "player" && Math.hypot(n.x - target.x, n.y - target.y) < 200 && n !== target).length;
    target.isolationScore = nearbyEnemies;
  });
  
  targets.sort((a, b) => {
    const aPrio = {base: 10, base2: 10, base3: 10, warehouse: 8, barracks: 7, beacon: 6}[a.type] || 5;
    const bPrio = {base: 10, base2: 10, base3: 10, warehouse: 8, barracks: 7, beacon: 6}[b.type] || 5;
    return (bPrio - b.isolationScore * 2) - (aPrio - a.isolationScore * 2);
  });
  
  const target = targets[0]; // 🔥 ЭТО УЗЕЛ ГРАФА
  if (!target) return false;
  
  const freeUnits = gameState.units.filter(u => u.owner === "ai" && ["fighter", "assault", "elite"].includes(u.type) && u.health > 0 && (!u.commandQueue || u.commandQueue.length === 0));
  if (freeUnits.length === 0) return false;
  
  const threatZones = state.nodes.filter(n => n.valid && n.isVirtual && n.virtualType === "threat");
  const directPathBlocked = threatZones.some(zone => Math.hypot(zone.x - target.x, zone.y - target.y) < zone.threatRadius + 100);
  
  const waypoints = directPathBlocked 
    ? (() => {
        const flankNodes = state.nodes.filter(n => n.valid && n.isVirtual && n.virtualType === "flank");
        const nearestFlank = flankNodes.reduce((best, n) => {
          const distToTarget = Math.hypot(n.x - target.x, n.y - target.y);
          const bestDist = best ? Math.hypot(best.x - target.x, best.y - target.y) : Infinity;
          return distToTarget < bestDist ? n : best;
        }, null);
        return nearestFlank ? [{type: "move", x: nearestFlank.x, y: nearestFlank.y}, {type: "move", x: target.x, y: target.y}] : [{type: "move", x: target.x + (target.y > aiBase.y ? -200 : 200), y: target.y}];
      })()
    : [{type: "move", x: target.x, y: target.y}];
  
  freeUnits.forEach(u => {
    // 🔥 ПРОВЕРКА: если цель - отряд, берем первого юнита, иначе target.obj
    const physicalTarget = (target.obj && target.obj.units) ? target.obj.units[0] : target.obj;
    u.commandQueue = [...waypoints, {type: "attack", target: physicalTarget}];
  });
  
  this.registerAction(action, state, {type: "attack", targetId: target.obj ? target.obj.id : "unknown", tactic: "strike_weak", targetIsolation: target.isolationScore, pathBlocked: directPathBlocked}, actionIndex);
  console.log(`[GnnAI] 🎯 Удар по слабому месту: ${target.type} (изоляция: ${target.isolationScore}), путь заблокирован: ${directPathBlocked}`);
  return true;
}
if (action === "focus_fire") {
  const enemyTargets = state.nodes.filter(n => n.valid && n.owner === "player" && n.hp > 0);
  if (enemyTargets.length === 0) return false;

  enemyTargets.sort((a, b) => {
    const aIsBuilding = ["base", "warehouse", "barracks", "turret"].includes(a.type) ? 0 : 1;
    const bIsBuilding = ["base", "warehouse", "barracks", "turret"].includes(b.type) ? 0 : 1;
    if (aIsBuilding !== bIsBuilding) return aIsBuilding - bIsBuilding;
    if (a.targetPriority === b.targetPriority) return a.hp - b.hp; 
    return b.targetPriority - a.targetPriority;
  });

  const target = enemyTargets[0]; // 🔥 ЭТО УЗЕЛ ГРАФА
  
  const freeUnits = gameState.units.filter(u => u.owner === "ai" && ["fighter", "assault", "elite"].includes(u.type) && u.health > 0 && (!u.commandQueue || u.commandQueue.length === 0));
  if (freeUnits.length === 0) return false;

  freeUnits.forEach(u => {
    // 🔥 ПРОВЕРКА: если цель - отряд, берем первого юнита, иначе target.obj
    const physicalTarget = (target.obj && target.obj.units) ? target.obj.units[0] : target.obj;
    
    u.commandQueue = [{
      type: "attack", 
      target: physicalTarget || {x: target.x, y: target.y, type: target.type, owner: "player", health: target.hp * 100}
    }];
  });
  
  this.registerAction(action, state, {type: "attack", targetId: target.obj?.id || "unknown", tactic: "focus_fire"}, actionIndex);
  return true;
}

    if (action === "retreat_regroup") {
      const wounded = gameState.units.filter(u => 
        u.owner === "ai" && ["fighter", "assault", "elite"].includes(u.type) && 
        u.health > 0 && u.health < u.maxHealth * 0.5
      );
      const aiCombat = gameState.units.filter(u => u.owner === "ai" && ["fighter", "assault", "elite"].includes(u.type) && u.health > 0);
      const rallyPoint = aiCombat.length >= 3 
        ? { x: aiCombat.reduce((s, u) => s + u.x, 0) / aiCombat.length, y: aiCombat.reduce((s, u) => s + u.y, 0) / aiCombat.length }
        : aiBase;
      wounded.forEach(u => {
        u.commandQueue = [{type: "move", x: rallyPoint.x + (Math.random() - 0.5) * 100, y: rallyPoint.y + (Math.random() - 0.5) * 100}];
      });
      this.registerAction(action, state, {type: "retreat", anchor: rallyPoint}, actionIndex);
      return true;
    }

if (action === "flank_attack") {
  // 1. Находим фланговые точки из виртуальных узлов
  const flankNodes = state.nodes.filter(n => n.valid && n.isVirtual && n.virtualType === "flank");
  
  if (flankNodes.length < 2) {
    // Фоллбэк: если фланговых точек нет, используем старую логику
    const enemyUnits = gameState.units.filter(u => u.owner === "player" && u.health > 0);
    if (enemyUnits.length === 0) return false;
    
    const enemyCenter = {
      x: enemyUnits.reduce((s, u) => s + u.x, 0) / enemyUnits.length,
      y: enemyUnits.reduce((s, u) => s + u.y, 0) / enemyUnits.length
    };
    const flankAngle = Math.atan2(enemyCenter.y - aiBase.y, enemyCenter.x - aiBase.x) + Math.PI / 2;
    const flankPoint = {
      x: enemyCenter.x + Math.cos(flankAngle) * 300,
      y: enemyCenter.y + Math.sin(flankAngle) * 300
    };
    
    const freeUnits = gameState.units.filter(u => u.owner === "ai" && ["fighter", "assault", "elite"].includes(u.type) && u.health > 0 && (!u.commandQueue || u.commandQueue.length === 0));
    if (freeUnits.length === 0) return false;
    
    const fallbackTarget = enemyUnits[0];
    freeUnits.forEach(u => {
      u.commandQueue = [
        {type: "move", x: flankPoint.x, y: flankPoint.y},
        {type: "attack", target: fallbackTarget}
      ];
    });
    this.registerAction(action, state, {type: "attack", tactic: "flank"}, actionIndex);
    return true;
  }
  
  // 2. Берём 2 фланговые точки
  const flank1 = flankNodes[0];
  const flank2 = flankNodes[Math.min(1, flankNodes.length - 1)];
  
  // 3. Находим свободных юнитов
  const freeUnits = gameState.units.filter(u => u.owner === "ai" && ["fighter", "assault", "elite"].includes(u.type) && u.health > 0 && (!u.commandQueue || u.commandQueue.length === 0));
  if (freeUnits.length < 2) return false;
  
  // 4. Разделяем армию на 2 группы
  const groups = this.splitArmyIntoGroups(freeUnits, 2);
  
  // 5. 🔥 НАХОДИМ ЦЕЛЬ ИЗ ГРАФА (чтобы поддержать отряды/squads)
  const targetNode = state.nodes.find(n => 
    n.valid && n.owner === "player" && 
    (n.type.includes("base") || ["fighter", "assault", "elite", "warehouse", "barracks"].includes(n.type))
  );
  
  // Фоллбэк, если граф вдруг пуст
  const fallbackTarget = targetNode ? targetNode.obj : gameState.units.find(u => u.owner === "player" && u.health > 0);

  // 6. Отправляем каждую группу к своей фланговой точке
  groups.forEach((group, idx) => {
    const flankPoint = idx === 0 ? flank1 : flank2;
    group.forEach(u => {
      // 🔥 ПРАВИЛЬНАЯ ПРОВЕРКА: если это отряд, берем первого юнита, иначе сам объект
      const physicalTarget = (targetNode && targetNode.obj && targetNode.obj.units) 
        ? targetNode.obj.units[0] 
        : fallbackTarget;

      u.commandQueue = [
        {type: "move", x: flankPoint.x, y: flankPoint.y},
        {type: "attack", target: physicalTarget}
      ];
    });
  });
  
  this.registerAction(action, state, {
    type: "attack", tactic: "flank",
    group1Size: groups[0].length, group2Size: groups[1].length,
    flank1: {x: flank1.x, y: flank1.y}, flank2: {x: flank2.x, y: flank2.y}
  }, actionIndex);
  
  console.log(`[GnnAI] ⚔️ Фланговая атака: Группа 1 (${groups[0].length}) → (${flank1.x.toFixed(0)}, ${flank1.y.toFixed(0)}), Группа 2 (${groups[1].length}) → (${flank2.x.toFixed(0)}, ${flank2.y.toFixed(0)})`);
  return true;
}

if (action === "harass_economy") {
  // 1. Ищем экономические цели противника в памяти ИИ (state.nodes)
  const ecoTargets = state.nodes.filter(n => 
    n.valid && n.owner === "player" && 
    ["warehouse", "repairWorkshop", "worker"].includes(n.type) && n.hp > 0
  );

  if (ecoTargets.length === 0) return false;

  // 2. Сортируем по близости к нашей базе (чтобы отправлять ближних разведчиков/файтеров)
  ecoTargets.sort((a, b) => {
    const distA = Math.hypot(a.x - aiBase.x, a.y - aiBase.y);
    const distB = Math.hypot(b.x - aiBase.x, b.y - aiBase.y);
    return distA - distB;
  });

  const target = ecoTargets[0];

  // 3. Берем своих файтеров (они лучше всего подходят для харасса)
  const fighters = gameState.units.filter(u => 
    u.owner === "ai" && u.type === "fighter" && u.health > 0 && (!u.commandQueue || u.commandQueue.length === 0)
  );
  
  if (fighters.length === 0) return false;

  fighters.forEach(u => {
    // 🔥 КЛЮЧЕВОЕ ИСПРАВЛЕНИЕ: если цель - это отряд (squad), берем первый юнит из него
    const physicalTarget = (target.obj && target.obj.units) ? target.obj.units[0] : target.obj;
    
    u.commandQueue = [{
      type: "attack", 
      target: physicalTarget || {x: target.x, y: target.y, type: target.type, owner: "player", health: target.hp * 100}
    }];
  });
  
  this.registerAction(action, state, {
    type: "attack", 
    tactic: "harass_economy", 
    targetId: target.obj ? (target.obj.id || (target.obj.units ? target.obj.units[0].id : "unknown")) : "unknown"
  }, actionIndex);
  
  return true;
}
  } catch (e) {
    console.warn("[GnnAI execute error]", action, e);
  }
  return false;
},

    tryBuildSpecific: function(buildingType, cost, action, actionIndex, state) {
      const res = gameState.aiResources;
      const canAfford = (res.gold || 0) >= (cost.gold || 0) && 
                        (res.silicon || 0) >= (cost.silicon || 0) && 
                        (res.plasma || 0) >= (cost.plasma || 0);
      if (!canAfford) {
        this.replay.push({ X: state.X, A_distance: state.A_distance, A_threat: state.A_threat, actionIndex: actionIndex, reward: -0.3 });
        return false;
      }   
      const prereq = this.PREREQUISITES[buildingType];
      if (prereq && !gameState.buildings.some(b => b.owner === "ai" && b.type === prereq && b.health > 0)) {
        this.replay.push({ X: state.X, A_distance: state.A_distance, A_threat: state.A_threat, actionIndex: actionIndex, reward: -5.0 });
        console.warn(`[GnnAI] ⛔ Хак заблокирован: ${buildingType} без ${prereq}`);
        return false;
      }
      let anchor = aiBase;
if (buildingType === "beacon") {
    // Якорь = самое дальнее здание ИИ (требование зоны 320px)
    let far = aiBase, maxD = 0;
    gameState.buildings.forEach(b => {
        if (b.owner === "ai" && b.active && b.health > 0) {
            const d = Math.hypot(b.x - aiBase.x, b.y - aiBase.y);
            if (d > maxD) { maxD = d; far = b; }
        }
    });
    anchor = far;
    // 🔥 Но строим маяк В НАПРАВЛЕНИИ к ближайшему НЕобслуженному богатому кластеру
    const cluster = this.findBestResourceCluster();
    if (cluster) {
        const ang = Math.atan2(cluster.y - far.y, cluster.x - far.x);
        const r = 200; // в пределах зоны 320px от якоря
        const tx = far.x + Math.cos(ang) * r;
        const ty = far.y + Math.sin(ang) * r;
        const pos = this.findBuildPos({x: tx, y: ty}, "beacon", 0, 120);
        if (pos) {
            const scheduled = scheduleAIBuilding("beacon", pos.x, pos.y, 0);
            if (scheduled) {
                this.registerAction(action, state, { type: "build", buildingType:"beacon" }, actionIndex);
                return true;
            }
        }
    }
}
      else if (["warehouse","repairWorkshop","turret","turret2","turret3"].includes(buildingType)) {
        const outpost = this.findExpansionAnchor();
        if (outpost) {
          const pos = this.findBuildPos(outpost, buildingType, 60, 150);
          if (!pos) {
            this.replay.push({ X: state.X, A_distance: state.A_distance, A_threat: state.A_threat, actionIndex: actionIndex, reward: -0.3 });
            return false;
          }
          const scheduled = scheduleAIBuilding(buildingType, pos.x, pos.y, 0);
          if (scheduled) {
            this.registerAction(action, state, { type: "build", buildingType: buildingType }, actionIndex);
            return true;
          }
          return false;
        }
        const wh = gameState.buildings.find(b => b.owner === "ai" && b.type ==="warehouse" && b.health > 0);
        if (wh) anchor = wh;
      } 
      else if (["barracks","barracks2","barracks3","base2","base3"].includes(buildingType)) {
        const outpost = this.findExpansionAnchor();
        if (outpost) anchor = outpost;
        else {
          const wh = gameState.buildings.find(b => b.owner === "ai" && b.type ==="warehouse" && b.health > 0);
          if (wh) anchor = wh;
        }
      }
      const pos = this.findBuildPos(anchor, buildingType, 70, 240);
      if (!pos) {
        this.replay.push({ X: state.X, A_distance: state.A_distance, A_threat: state.A_threat, actionIndex: actionIndex, reward: -0.3 });
        return false;
      }
      const scheduled = scheduleAIBuilding(buildingType, pos.x, pos.y, 0);
      if (scheduled) {
        this.registerAction(action, state, { type: "build", buildingType: buildingType }, actionIndex);
        return true;
      }
      return false;
    },

    enqueueUnit: function (type, buildingType, cost) {
      const b = gameState.buildings.find(x => x.owner === "ai" && x.type === buildingType && x.active && (!x.productionQueue || x.productionQueue.length < (x.productionLimit || 3)));
      if (!b || !canSpendResources(cost, "ai") || typeof aiEnqueueMilitaryUnit !=="function") return false;
      if (!aiEnqueueMilitaryUnit(type, b)) return false;
		gameState.aiResources.gold = Math.round((gameState.aiResources.gold || 0) - (cost.gold || 0));
		gameState.aiResources.silicon = Math.round((gameState.aiResources.silicon || 0) - (cost.silicon || 0));
		gameState.aiResources.plasma = Math.round((gameState.aiResources.plasma || 0) - (cost.plasma || 0));
      if (typeof updateResourceUI === "function") updateResourceUI();
      return true;
    },

    autoEconomy: function () {
      if (gameMode === "gnn") return; // 🔥 ОТКЛЮЧАЕМ для GNN
      if (window.fullRLMode) return;
      if (typeof aiHireWorker !== "function") return;
      for (const b of gameState.buildings) {
        if (b.owner !== "ai" || !b.active) continue;
        if (b.type === "warehouse") {
          const maxWorkers = b.maxDeliveryWorkers || 5;
          const currentWorkers = b.workers || 0;
          if (currentWorkers < Math.ceil(maxWorkers / 2)) {
            let guard = 0;
            while (currentWorkers + guard < maxWorkers && guard < 1 && canSpendResources(WORKER_COST, "ai")) {
              aiHireWorker(b);
              guard++;
            }
          }
        }
        if (b.type === "repairWorkshop" && typeof aiHireRepairMan ==="function") {
          const woundedUnits = gameState.units.filter(u => u.owner === "ai" && u.health > 0 && u.health < u.maxHealth).length;
          const maxRepairmen = b.capacity || 3;
          const currentRepairmen = b.repairman || 0;
          if (woundedUnits > 0 && currentRepairmen < maxRepairmen) {
            let guard = 0;
            while (currentRepairmen + guard < maxRepairmen && guard < 1 && canSpendResources(REPAIRMAN_COST, "ai")) {
              aiHireRepairMan(b);
              guard++;
            }
          }
        }
      }
    }, 

    threatAnchor: function () {
      const anchors = gameState.buildings.filter(b => b.owner === "ai" && ["base","base2","base3","beacon","warehouse","repairWorkshop","barracks","barracks2","barracks3"].includes(b.type) && b.health > 0);
      if (!anchors.length) return aiBase;
      const enemies = [...gameState.units.filter(u => u.owner === "player" && u.health > 0), ...gameState.buildings.filter(b => b.owner ==="player" && b.health > 0)];
      let best = aiBase, bestScore = -Infinity;
      for (const a of anchors) {
        let score = (1 - a.health / a.maxHealth) * 150 + (a.type.startsWith("base") ? 100 : 50);
        for (const e of enemies) {
          const d = Math.hypot(a.x - e.x, a.y - e.y);
          if (d < CFG.BASE_THREAT_RADIUS) score += ((CFG.BASE_THREAT_RADIUS - d) / CFG.BASE_THREAT_RADIUS) * 200;
        }
        const existingDefenders = gameState.units.filter(u => u.owner === "ai" && u.defending && Math.hypot(u.x - a.x, u.y - a.y) < 200).length;
        score -= existingDefenders * 30;
        if (score > bestScore) { bestScore = score; best = a; }
      }
      return best;
    },

findExpansionAnchor: function () {
    const beacons = gameState.buildings.filter(b =>
        b.owner === "ai" && b.type ==="beacon" && b.active && b.health > 0
    );
    // 🔥 Если маяков НЕТ, якорем является главная база (чтобы соблюсти правило < 320px)
    if (beacons.length === 0) {
        return aiBase;
    }
    // Если маяки есть, ищем самый недостроенный
    const scored = beacons.map(bc => {
        const nearbyUseful = gameState.buildings.filter(b =>
            b.owner === "ai" && b !== bc &&
            ["warehouse","repairWorkshop","barracks","barracks2","barracks3","turret","turret2","turret3"].includes(b.type) &&
            Math.hypot(b.x - bc.x, b.y - bc.y) < 220
        ).length;
        return { beacon: bc, useful: nearbyUseful, dist: Math.hypot(bc.x - aiBase.x, bc.y - aiBase.y) };
    });
    scored.sort((a, b) => (a.useful - b.useful) || (b.dist - a.dist));
    const target = scored[0];
    if (target.useful >= 3) return null; // форт уже достроен
    return target.beacon;
},

findBuildPos: function (anchor, type, minR = 80, maxR = 310) { // 🔥 maxR = 310, чтобы гарантированно быть < 320
    if (!anchor) anchor = aiBase;
    const wW = typeof worldWidth !== 'undefined' ? worldWidth : 2000;
    const wH = typeof worldHeight !== 'undefined' ? worldHeight : 2000;
    const safeMargin = 60;
    for (let i = 0; i < 200; i++) {
        const a = Math.random() * Math.PI * 2;
        const r = minR + Math.random() * (maxR - minR);
        const x = anchor.x + Math.cos(a) * r;
        const y = anchor.y + Math.sin(a) * r;
        if (x < safeMargin || y < safeMargin || x > wW - safeMargin || y > wH - safeMargin) continue;
        // 🔥 СТРОГОЕ ПРАВИЛО ИГРЫ: должно быть < 320px от здания ИИ
        if (typeof isValidAiBuildLocation === "function" && !isValidAiBuildLocation(x, y)) continue;
        // 🔥 ТОЧНЫЕ РАЗМЕРЫ ИЗ placeBuilding (чтобы коллизии совпадали с игрой)
        const dims = { 
            warehouse: [10, 10], repairWorkshop: [10, 10], 
            barracks: [15, 15], barracks2: [15, 15], barracks3: [15, 15], 
            turret: [12, 12], turret2: [15, 17], turret3: [14, 15], 
            beacon: [7, 20], base2: [25, 30], base3: [30, 30] 
        }[type] || [20, 20];
        const rect = { left: x - dims[0] / 2, top: y - dims[1] / 2, right: x + dims[0] / 2, bottom: y + dims[1] / 2 };
        let bad = false;
        for (const b of gameState.buildings) {
            // 🔥 ОТСТУП 5px, как в placeBuilding
            const br = { left: b.x - b.width / 2 - 5, top: b.y - b.height / 2 - 5, right: b.x + b.width / 2 + 5, bottom: b.y + b.height / 2 + 5 };
            if (typeof rectsOverlap === "function" && rectsOverlap(rect, br)) { 
                bad = true; 
                break; 
            }
        }
        if (!bad) {
            console.log(`[GnnAI] ✅ Найдено место: ${type} на (${x.toFixed(0)}, ${y.toFixed(0)})`);
            return { x, y };
        }
    }
    // Fallback, если случайный поиск не удался
    const offsets = [
        { x: anchor.x + 200, y: anchor.y }, { x: anchor.x - 200, y: anchor.y },
        { x: anchor.x, y: anchor.y + 200 }, { x: anchor.x, y: anchor.y - 200 }
    ];
    for (const pos of offsets) {
        if (pos.x < safeMargin || pos.y < safeMargin || pos.x > wW - safeMargin || pos.y > wH - safeMargin) continue;
        if (typeof isValidAiBuildLocation === "function" && !isValidAiBuildLocation(pos.x, pos.y)) continue;
        const dims = { warehouse: [10, 10], repairWorkshop: [10, 10], barracks: [15, 15], turret: [12, 12], beacon: [7, 20] }[type] || [20, 20];
        const rect = { left: pos.x - dims[0] / 2, top: pos.y - dims[1] / 2, right: pos.x + dims[0] / 2, bottom: pos.y + dims[1] / 2 };
        let bad = false;
        for (const b of gameState.buildings) {
            const br = { left: b.x - b.width / 2 - 5, top: b.y - b.height / 2 - 5, right: b.x + b.width / 2 + 5, bottom: b.y + b.height / 2 + 5 };
            if (typeof rectsOverlap === "function" && rectsOverlap(rect, br)) { bad = true; break; }
        }
        if (!bad) return pos;
    }
    return null;
},

    metrics: function () {
      // Кэшируем результат на 100ms
      if (this._metricsCache && performance.now() - this._metricsCacheTime < 100) {
        return this._metricsCache;
      }
      const baseHp = aiBase && aiBase.maxHealth ? Math.max(0, aiBase.health / aiBase.maxHealth) : 0;
      const enemyNear = gameState.units.filter(u => u.owner === "player" && u.health > 0 && aiBase && Math.hypot(u.x - aiBase.x, u.y - aiBase.y) < CFG.BASE_THREAT_RADIUS).length;
      const aiArmy = gameState.units.filter(u => u.owner === "ai" && ["fighter","assault","elite"].includes(u.type) && u.health > 0).length;
      const enemyArmy = gameState.units.filter(u => u.owner === "player" && ["fighter","assault","elite"].includes(u.type) && u.health > 0).length;
      let techLevel = 1;
      if (gameState.buildings.some(b => b.owner === "ai" && ["base2","barracks2","turret2"].includes(b.type))) techLevel = 2;
      if (gameState.buildings.some(b => b.owner === "ai" && ["base3","barracks3","turret3"].includes(b.type))) techLevel = 3;
      const aiBuildings = gameState.buildings.filter(b => b.owner === "ai" && b.health > 0).length;
      const aiTurrets = gameState.buildings.filter(b => b.owner === "ai" && b.type?.startsWith("turret") && b.health > 0).length;
      const aiWarehouses = gameState.buildings.filter(b => b.owner === "ai" && b.type ==="warehouse" && b.health > 0).length;
      const playerAlive = gameState.buildings.some(b => b.owner === "player" && b.health > 0);
      const ar = gameState.aiResources || {};
      const resTotalRaw = (ar.gold || 0) + (ar.silicon || 0) + (ar.plasma || 0);
      const resTotal = Math.min(1, resTotalRaw / 2000);
      const ecoEfficiency = resTotal > 0.001 ? (aiArmy / (resTotal / 100)) : 0;
      return { 
        baseHp, enemyNear, aiArmy, enemyArmy, techLevel, aiBuildings, aiTurrets, aiWarehouses, playerAlive, 
        resTotal, ecoEfficiency,
        res: { gold: Math.round(ar.gold || 0), silicon: Math.round(ar.silicon || 0), plasma: Math.round(ar.plasma || 0) } 
      };
      const result = {
        baseHp, enemyNear, aiArmy, enemyArmy, techLevel, aiBuildings, aiTurrets, aiWarehouses, playerAlive,
        resTotal, ecoEfficiency,
        res: { gold: Math.round(ar.gold || 0), silicon: Math.round(ar.silicon || 0), plasma: Math.round(ar.plasma || 0) }
      };
      
      this._metricsCache = result;
      this._metricsCacheTime = performance.now();
      return result;
    },

    startEpisode: function (mode) {
      if (CFG.BC_MODE) {
          this.bcActive = true;
          this.bcBatchCount = 0;
      }
      this.episode = { mode, start: performance.now(), firstThreatAt: null, firstDefenseAt: null, minBaseHp: 1, actions: {}, ended: false, result: null };
      this.episodeReport = { actions: {}, timeline: [] };
      // 🔥 сброс кредит-ассайнмента, чтобы награды прошлого матча не текли в новый
      this.lastReplayEntry = null;
      this._pendingShaped = 0;
      this.lastTechStagnationCheck = 0;
      this._lastRewardedTechLevel = 1;
      this._lastKnownTechLevel = 1;
      this._lastTierTransitionTime = 0;
      this._lastOutpostCount = 0;
      this._lastArmyPositions = null;
      this._lastKillCount = 0;
      this._lastDeathCount = 0;
      this._lastDamageDealt = 0;
      this._lastDamageTaken = 0;		this.episodeAchievements = {
		firstBarracks: false, firstBase2: false, firstBarracks2: false,
		firstBase3: false, firstAssault: false, firstElite: false,
		firstBeacon: false // 🔥 НОВОЕ
	};
    },

    benchmarkTick: function (mode, action) {
      if (gameMode !== mode || !this.episode || this.episode.mode !== mode || this.episode.ended) return;
      const m = this.metrics();
      const now = performance.now();
      this.episode.minBaseHp = Math.min(this.episode.minBaseHp, m.baseHp);
      if (action) this.episode.actions[action] = (this.episode.actions[action] || 0) + 1;
      if (this.episode.firstThreatAt === null && m.enemyNear > 0) this.episode.firstThreatAt = now;
    },

finishEpisode: function (result) {
  if (!this.episode || this.episode.ended) return;
  this.episode.ended = true;
  this.episode.result = result;
  this.episode.duration = performance.now() - this.episode.start;
  
  // 🔥 КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: Финальная награда за результат матча
  const finalReward = (result === "win") ? 500.0 : -500.0;
  
  // Применяем награду к последнему состоянию
  if (this.lastState) {
    this.replay.push({
      X: this.lastState.X,
      A_distance: this.lastState.A_distance,
      A_threat: this.lastState.A_threat,
      actionIndex: AIDX.idle,
      reward: finalReward
    });
    
    if (result === "win") {
      console.log(`[GnnAI] 🏆 ПОБЕДА! Финальная награда: +${finalReward.toFixed(1)}`);
    } else {
      console.warn(`[GnnAI] 💀 ПОРАЖЕНИЕ! Финальный штраф: ${finalReward.toFixed(1)}`);
    }
  }
  
  // CURRICULUM PROGRESSION LOGIC
  if (result === "win") {
    this.episodesInCurrentTier++;    
    // Проверка целей для повышения тира
    let shouldAdvance = false;
    if (this.curriculumTier === 0 && this.tierGoalsMet.barracks) shouldAdvance = true;
    if (this.curriculumTier === 1 && this.tierGoalsMet.base2) shouldAdvance = true;
    if (this.curriculumTier === 2 && this.tierGoalsMet.base3) shouldAdvance = true;
    // Или если просто набралось много побед
    if (this.episodesInCurrentTier >= this.TIER_THRESHOLD) shouldAdvance = true;
    if (shouldAdvance && this.curriculumTier < 3) {
      this.curriculumTier++;
      this.episodesInCurrentTier = 0;
      console.log(`[Curriculum] 🎓 Уровень повышен до Tier ${this.curriculumTier}!`);
    }
  }
  
  const row = {
    mode: this.episode.mode, result, date: new Date().toISOString(),
    durationSec: +(this.episode.duration / 1000).toFixed(2),
    minBaseHp: +this.episode.minBaseHp.toFixed(3), actions: { ...this.episode.actions }
  };
  const stats = this.readStats();
  stats.push(row);
  while (stats.length > 80) stats.shift();
  localStorage.setItem(CFG.STATS_KEY, JSON.stringify(stats));
  console.log("[GnnAI benchmark] saved", row);
  this.printEpisodeReport(result);
  this.stats();
},

    readStats: function () {
      try { return JSON.parse(localStorage.getItem(CFG.STATS_KEY) || "[]"); } catch { return []; }
    },

    stats: function () {
      const rows = this.readStats();
      const by = {};
      for (const r of rows) { if (!by[r.mode]) by[r.mode] = []; by[r.mode].push(r); }
      const summary = {};
      for (const mode of Object.keys(by)) {
        const list = by[mode];
        const hp = list.map(x => x.minBaseHp).filter(x => typeof x === "number");
        const wins = list.filter(x => x.result === "win").length;
        summary[mode] = { episodes: list.length, wins, winRate: +(wins / list.length).toFixed(3), avgMinBaseHp: hp.length ? +(hp.reduce((a, b) => a + b, 0) / hp.length).toFixed(3) : null };
      }
      console.table(summary);
      return summary;
    },

    inspectWeights: function () {
      if (!this.vars || this.vars.length === 0) { console.warn("[GnnAI] Веса еще не инициализированы."); return; }
      console.group("🧠 [GnnAI] РЕНТГЕН МОЗГА");
      let totalParams = 0, totalZero = 0, totalInf = 0, maxWeight = -Infinity, minWeight = Infinity;
      this.vars.forEach((v, i) => {
        const data = v.dataSync();
        const shape = v.shape.join('x');
        let layerZero = 0, layerInf = 0, layerMax = -Infinity, layerMin = Infinity, layerSum = 0;
        for (let j = 0; j < data.length; j++) {
          const val = data[j]; totalParams++; layerSum += val;
          if (val === 0) layerZero++;
          if (!isFinite(val)) layerInf++;
          if (val > layerMax) layerMax = val;
          if (val < layerMin) layerMin = val;
          if (val > maxWeight) maxWeight = val;
          if (val < minWeight) minWeight = val;
        }
        const avg = layerSum / data.length;
        console.log(`Слой ${i} (${shape}): Ср=${avg.toFixed(4)} | Мин=${layerMin.toFixed(2)} | Макс=${layerMax.toFixed(2)} | Нулей=${layerZero}`);
      });
      console.log(`📊 ИТОГО: ${totalParams} параметров.`);
      console.log(`⚠️ Бесконечностей (NaN/Inf): ${totalInf}`);
      console.log(`📉 Диапазон весов: от ${minWeight.toFixed(4)} до ${maxWeight.toFixed(4)}`);
      if (totalInf > 0) console.error("❌ КРИТИЧЕСКАЯ ОШИБКА: В сети есть бесконечности! Нужен сброс.");
      else if (Math.abs(maxWeight) > 100) console.warn("⚠️ ВНИМАНИЕ: Очень большие веса. Возможен взрыв градиента.");
      else if (Math.abs(maxWeight) < 0.001 && totalParams > 1000) console.warn("⚠️ ВНИМАНИЕ: Веса стремятся к нулю. Сеть 'схлопнулась'.");
      else console.log("✅ Сеть выглядит здоровой.");
      console.groupEnd();
    },

calculateWeightStats: function() {
  if (!this.vars || this.vars.length === 0) return null;
  
  let totalWeights = 0;
  let sum = 0, sumSq = 0;
  let min = Infinity, max = -Infinity;
  let l2Norm = 0;

  for (const v of this.vars) {
    const data = v.dataSync();
    for (let i = 0; i < data.length; i++) {
      const val = data[i];
      if (!isFinite(val)) continue;
      sum += val;
      sumSq += val * val;
      if (val < min) min = val;
      if (val > max) max = val;
      l2Norm += val * val;
      totalWeights++;
    }
  }

  const avg = totalWeights > 0 ? sum / totalWeights : 0;
  // 🔥 СТАНДАРТНОЕ ОТКЛОНЕНИЕ — главная новая метрика
  const variance = totalWeights > 0 ? (sumSq / totalWeights) - (avg * avg) : 0;
  const std = Math.sqrt(Math.max(0, variance));
  const currentL2 = Math.sqrt(l2Norm);

  // 🔥 ДЕЛЬТА ОТ НАЧАЛА ИГРЫ (sessionStartL2 фиксируется при старте матча)
  let deltaSession = 0;
  if (this.sessionStartL2 && this.sessionStartL2 > 0) {
    deltaSession = ((currentL2 - this.sessionStartL2) / this.sessionStartL2) * 100;
  }

  // 🔥 ДЕЛЬТА ОТ ПОСЛЕДНЕГО СЕЙВА (старая, оставляем для справки)
  let deltaSave = 0;
  if (this.lastWeightSnapshot) {
    const diff = Math.abs(currentL2 - this.lastWeightSnapshot.l2);
    deltaSave = Math.min(100, (diff / (this.lastWeightSnapshot.l2 + 1e-8)) * 100);
  }

  return {
    count: totalWeights,
    avg, min, max, std,
    l2: currentL2,
    deltaSession,   // 🔥 НОВОЕ: рост с начала игры
    deltaSave,      // старое, но переименовано
    timestamp: performance.now()
  };
},

// 🔥 ДИНАМИЧЕСКАЯ ЭНТРОПИЯ: расписание затухания
getEntropyCoef: function() {
  const batch = this.trainBatches;
  
  // 🔥 Фаза 1: Активное исследование (0-300 батчей)
  // Модель активно пробует разные действия
  if (batch < 300) {
    return 0.05;
  }
  // 🔥 Фаза 2: Плавный переход (300-1500 батчей)
  // Модель начинает оттачивать рабочие стратегии
  else if (batch < 1500) {
    const progress = (batch - 300) / 1200; // 0 → 1
    // Линейная интерполяция: 0.05 → 0.01
    return 0.05 - (0.05 - 0.01) * progress;
  }
  // 🔥 Фаза 3: Эксплуатация знаний (1500+ батчей)
  // Модель действует как хладнокровный гроссмейстер
  else {
    return 0.01;
  }
},

checkEnd: async function () {
  if (gameState.gameEnded) return;
  const aiBaseAlive = gameState.buildings.some(b => b.owner === "ai" && b.type === "base" && b.health > 0);
  const playerBaseAlive = gameState.buildings.some(b => b.owner === "player" && b.type === "base" && b.health > 0);
  
  if (!aiBaseAlive || !playerBaseAlive) {
    gameState.gameEnded = true;
    console.log("[GnnAI] 💾 Игра завершена. Сохранение весов...");
    
    // 🔥 ПРИНУДИТЕЛЬНОЕ СОХРАНЕНИЕ С ОБРАБОТКОЙ ОШИБОК
    try {
      await this.saveWeights();
      console.log("[GnnAI] ✅ Веса успешно сохранены перед завершением матча");
    } catch (e) {
      console.error("[GnnAI] ❌ Ошибка сохранения весов:", e);
      // 🔥 ПЛАН Б: сохраняем в localStorage как резервную копию
      try {
        const backup = this.vars.map(v => ({ 
          shape: v.shape, 
          values: Array.from(v.dataSync()).filter(isFinite) 
        }));
        localStorage.setItem(CFG.STORAGE_KEY + '_backup', JSON.stringify({
          version: 7.5,
          batches: this.trainBatches,
          data: backup,
          timestamp: Date.now()
        }));
        console.log("[GnnAI] 💾 Резервная копия сохранена в localStorage");
      } catch (e2) {
        console.error("[GnnAI] ❌ Даже резервное сохранение не удалось:", e2);
      }
    }
    
    // 🔥 ЖДЁМ 500мс, чтобы IndexedDB гарантированно закоммитил транзакцию
    await new Promise(r => setTimeout(r, 500));
    
    if (!aiBaseAlive) this.finishEpisode("loss");
    else this.finishEpisode("win");
    
    if (window.autoRestartEnabled) {
      setTimeout(() => {
        console.log("[Curriculum] 🔄 Перезагрузка страницы для 100% чистой новой игры...");
        localStorage.setItem('gnn_auto_restart', 'true'); 
        window.location.reload();
      }, 2000);
    } else {
      if (typeof showVictoryScreen === "function") showVictoryScreen(!aiBaseAlive ? "GNN ИИ проиграл." : "GNN ИИ победил!");
    }
  }
},

    // Внутри объекта GnnAI
    saveWeights: async function () {
    if (!this.vars || this.vars.length === 0) return;
    // 🔥 ЗАЩИТА: если WebGL контекст мёртв — НЕ читаем тензоры, иначе краш
    if (tf.getBackend() === 'webgl') {
        try {
            const canvas = document.querySelector('canvas');
            if (canvas) {
                const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
                if (gl && gl.isContextLost()) {
                    console.error("[GnnAI] 💥 WebGL контекст мёртв, сохранение отменено");
                    this.isSaving = false;
                    return;
                }
            }
        } catch (e) {}
    }

    // 🔥 ЗАЩИТА ОТ ПАНИКИ: Проверяем, нет ли NaN/Inf в весах перед сохранением
    let hasInvalidWeights = false;
    for (const v of this.vars) {
        // Быстрая проверка первых и последних значений, или полное сканирование если мало параметров
        const data = v.dataSync(); 
        for(let i=0; i<data.length; i++) {
            if (!isFinite(data[i])) {
                hasInvalidWeights = true;
                break;
            }
        }
        if(hasInvalidWeights) break;
    }

    if (hasInvalidWeights) {
        console.error("[GnnAI] ❌ Обнаружены NaN/Inf веса! Пропускаем сохранение, чтобы не убить контекст.");
        // Опционально: можно триггерить reset() здесь
        return;
    }

    try {
        console.log(`[GnnAI] 💾 Начало сохранения весов (Batch: ${this.trainBatches})...`);
        // 🔥 ЯДЕРНЫЙ ФИКС: переключиться на CPU для безопасного чтения dataSync()
        const originalBackend = tf.getBackend();
        if (originalBackend !== 'cpu') {
            console.log("[GnnAI] 🔄 Временное переключение на CPU backend...");
            await tf.setBackend('cpu');
            await tf.ready();
        }
        const mainData = this.vars.map(v => ({ 
            shape: v.shape, 
            values: Array.from(v.dataSync())
        }));
        const targetData = this.targetVars ? this.targetVars.map(v => ({ 
            shape: v.shape, 
            values: Array.from(v.dataSync()) 
        })) : [];
        // Возвращаем оригинальный backend
        if (originalBackend !== 'cpu') {
            console.log(`[GnnAI] 🔄 Возврат на backend: ${originalBackend}`);
            await tf.setBackend(originalBackend);
            await tf.ready();
        }

        const payload = {
            version: 7.6,
            batches: this.trainBatches,
            data: { main: mainData, target: targetData },
            backend: tf.getBackend(),
            actionsCount: G_ACTIONS.length,
            nodeFeatures: CFG.NODE_FEATURES,
            savedAt: Date.now()
        };

        // Убедимся, что соединение с БД живо
        if (!this.db) {
            await this.initWeightDB();
        }

        const tx = this.db.transaction('models', 'readwrite');
        const store = tx.objectStore('models');
        store.put(payload, CFG.STORAGE_KEY);

        await new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = (e) => reject(e.target.error);
        });

        console.log(`[GnnAI] ✅ Веса успешно сохранены в IndexedDB!`);
        
        // 🔥 СОХРАНЯЕМ "ТЕНЬ" ДЛЯ СЛЕДУЮЩЕГО СРАВНЕНИЯ
        // Вычисляем L2-норму напрямую, а не берём из currentWeightStats,
        // иначе при выключенной панели дельта будет врёт (сравнение с 0)
        try {
            let l2Sum = 0;
            for (const v of this.vars) {
                const data = v.dataSync();
                for (let i = 0; i < data.length; i++) {
                    if (isFinite(data[i])) l2Sum += data[i] * data[i];
                }
            }
            this.lastWeightSnapshot = {
                l2: Math.sqrt(l2Sum),
                timestamp: Date.now(),
                batches: this.trainBatches
            };
        } catch (e) {
            console.warn("[GnnAI] ⚠️ Не удалось зафиксировать тень весов:", e);
        }
    } catch (e) {
        console.error("[GnnAI] ❌ Критическая ошибка сохранения весов:", e);
        // Fallback в localStorage
        try {
            const backup = this.vars.map(v => ({ shape: v.shape, values: Array.from(v.dataSync()).filter(isFinite) }));
            localStorage.setItem(CFG.STORAGE_KEY + '_emergency_backup', JSON.stringify({
                version: 7.6, batches: this.trainBatches, data: { main: backup }, timestamp: Date.now()
            }));
        } catch (e2) {}
    } finally {
        this.isSaving = false;
    }
},

// 🔥 НОВЫЙ FALLBACK: Сохранение без использования TF.js шейдеров
_saveWeightsFallback: async function() {
  console.log("[GnnAI] 🔄 Запуск fallback сохранения...");
  
  try {
    // Переключаем backend на CPU (не использует WebGL)
    const originalBackend = tf.getBackend();
    await tf.setBackend('cpu');
    await tf.ready();
    
    // Теперь dataSync безопасен
    const mainData = this.vars.map(v => ({ 
      shape: v.shape, 
      values: Array.from(v.dataSync()) 
    }));
    
    const targetData = this.targetVars ? this.targetVars.map(v => ({ 
      shape: v.shape, 
      values: Array.from(v.dataSync()) 
    })) : [];
    
    const payload = {
      version: 7.6,
      batches: this.trainBatches,
      data: { main: mainData, target: targetData },
      backend: 'cpu-fallback',
      actionsCount: G_ACTIONS.length,
      nodeFeatures: CFG.NODE_FEATURES,
      savedAt: Date.now()
    };
    
    // Возвращаем оригинальный backend
    await tf.setBackend(originalBackend);
    await tf.ready();
    
    // Сохраняем в IndexedDB
    if (this.db) {
      const tx = this.db.transaction('models', 'readwrite');
      tx.objectStore('models').put(payload, CFG.STORAGE_KEY);
      console.log(`[GnnAI] 💾 Fallback: веса сохранены в IndexedDB (batch: ${this.trainBatches})`);
    } else {
      // Если БД недоступна — сохраняем в localStorage
      localStorage.setItem(CFG.STORAGE_KEY + '_backup', JSON.stringify(payload));
      console.log(`[GnnAI] 💾 Fallback: веса сохранены в localStorage`);
    }
    
  } catch (e) {
    console.error("[GnnAI] ❌ Fallback тоже не сработал:", e);
    // Последний шанс — сохраняем только метаданные
    try {
      localStorage.setItem(CFG.STORAGE_KEY + '_metadata', JSON.stringify({
        version: 7.6,
        batches: this.trainBatches,
        error: e.message,
        timestamp: Date.now()
      }));
    } catch (e2) {
      console.error("[GnnAI] ❌ Даже метаданные не сохранились");
    }
  }
}, 

// 🔥 НОВАЯ: прямой сохранитель в IndexedDB (если WeightDB отсутствует)
_saveToIndexedDB: async function(payload) {
  return new Promise((resolve, reject) => {
    const DB_NAME = 'GnnAI_Weights_DB';
    const STORE = 'models';
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = (e) => {
      const db = e.target.result;
      try {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(payload, CFG.STORAGE_KEY);
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = (ev) => { db.close(); reject(ev.target.error); };
      } catch (err) {
        db.close();
        reject(err);
      }
    };
    req.onerror = (e) => reject(req.error);
  });
},

    loadWeights: async function () {
      try {
        let obj = null;
        
        // 1. Пытаемся через WeightDB
        if (typeof WeightDB !== 'undefined' && WeightDB.load) {
          obj = await WeightDB.load(CFG.STORAGE_KEY);
        }
        
        // 2. Fallback: прямое чтение из IndexedDB
        if (!obj) {
          obj = await this._loadFromIndexedDB();
        }
        
        // 3. Fallback: localStorage backup
        if (!obj) {
          const backup = localStorage.getItem(CFG.STORAGE_KEY + '_backup');
          if (backup) {
            try { obj = JSON.parse(backup); console.log("[GnnAI] ✅ Загружено из localStorage backup"); } 
            catch (e) { console.warn("[GnnAI] ⚠️ backup повреждён"); }
          }
        }
        
        if (!obj) { 
          console.log("[GnnAI] Записей не найдено. Инициализация с нуля."); 
          return false; 
        }
        
        const mainData = obj.data?.main || obj.data;
        if (!Array.isArray(mainData)) { 
          console.warn("[GnnAI] Ошибка формата данных"); 
          return false; 
        }
        if (mainData.length !== this.vars.length) { 
          console.warn(`[GnnAI] Несовпадение архитектуры: ${mainData.length} vs ${this.vars.length}`); 
          return false; 
        }
        if (obj.actionsCount && obj.actionsCount !== G_ACTIONS.length) { 
          console.warn(`[GnnAI] ⚠️ Старая архитектура (${obj.actionsCount} действий). Сброс.`); 
          return false; 
        }
        if (obj.nodeFeatures && obj.nodeFeatures !== CFG.NODE_FEATURES) {
          console.warn(`[GnnAI] ⚠️ Несовпадение NODE_FEATURES: в БД ${obj.nodeFeatures}, в коде ${CFG.NODE_FEATURES}. Веса сброшены.`);
          return false;
        }
        
        const shapeMismatch = mainData.some((w, i) => {
          if (!this.vars[i]) return true;
          return w.shape.join(',') !== this.vars[i].shape.join(',');
        });
        if (shapeMismatch) {
          console.warn("[GnnAI] ⚠️ Shapes не совпадают. Сброс.");
          return false;
        }
        
        const checkInvalid = (arr) => arr && arr.some(w => w.values.some(v => !isFinite(v)));
        if (checkInvalid(mainData) || checkInvalid(obj.data?.target)) { 
          console.warn("[GnnAI] ⚠️ Веса повреждены (NaN/Inf). Сброс."); 
          return false; 
        }
        
        // 🔥 ПРИМЕНЯЕМ ВЕСА
        tf.tidy(() => { 
          mainData.forEach((w, i) => { 
            if (this.vars[i]) this.vars[i].assign(tf.tensor(w.values, w.shape)); 
          });
          const targetData = obj.data?.target;
          if (targetData && this.targetVars) {
            targetData.forEach((w, i) => { 
              if (this.targetVars[i]) this.targetVars[i].assign(tf.tensor(w.values, w.shape)); 
            });
          } else if (this.targetVars) {
            this.vars.forEach((v, i) => this.targetVars[i].assign(v.clone()));
          }
        });
        
        this.trainBatches = obj.batches || 0;
        
        // 🔥 НОВОЕ: СОХРАНЯЕМ "ТЕНЬ" ВЕСОВ ПОСЛЕ УСПЕШНОЙ ЗАГРУЗКИ
        try {
            let l2Sum = 0;
            for (const v of this.vars) {
                const data = v.dataSync();
                for (let i = 0; i < data.length; i++) {
                    if (isFinite(data[i])) l2Sum += data[i] * data[i];
                }
            }
            this.lastWeightSnapshot = {
                l2: Math.sqrt(l2Sum),
                timestamp: Date.now(),
                batches: this.trainBatches
            };
            console.log(`[GnnAI] 🌑 Тень весов загружена и зафиксирована (L2=${Math.sqrt(l2Sum).toFixed(2)})`);
        } catch (e) {
            console.warn("[GnnAI] ⚠️ Не удалось зафиксировать тень весов при загрузке:", e);
        }

        console.log(`[GnnAI] ✅ Веса успешно загружены (batch: ${this.trainBatches})`);
        return true;

      } catch (e) { 
        console.error("[GnnAI] Ошибка загрузки:", e); 
        return false; 
      }
    },

    _loadFromIndexedDB: async function() {
      return new Promise((resolve) => {
        const DB_NAME = 'GnnAI_Weights_DB';
        const STORE = 'models';
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
        };
        req.onsuccess = (e) => {
          const db = e.target.result;
          try {
            const tx = db.transaction(STORE, 'readonly');
            const getReq = tx.objectStore(STORE).get(CFG.STORAGE_KEY);
            getReq.onsuccess = () => { db.close(); resolve(getReq.result || null); };
            getReq.onerror = () => { db.close(); resolve(null); };
          } catch (err) {
            db.close();
            resolve(null);
          }
        };
        req.onerror = () => resolve(null);
      });
    },

    printEpisodeReport: function(result) {
      console.group(`📊 [GnnAI] ПОЛНЫЙ ОТЧЕТ О МАТЧЕ: ${result.toUpperCase()}`);
      if (!this.episodeReport) { console.groupEnd(); return; }
      console.log("🎯 Общее распределение действий:", this.episodeReport.actions);
      const keyEvents = this.episodeReport.timeline.filter(e => 
        e.detail === "barracks" || e.detail ==="barracks2" || e.detail ==="barracks3" || 
        e.detail === "base2" || e.detail ==="base3" || e.detail ==="warehouse" || 
        e.detail === "repairWorkshop" || e.detail ==="beacon" ||
        e.detail === "fighter" || e.detail ==="assault" || e.detail ==="elite" ||
        e.action === "attack_front" || e.action ==="attack_flank" || e.action ==="attack_feint"
      );
      if (keyEvents.length > 0) {
        console.log("🏗️ Ключевые события (постройки, найм, атаки):");
        console.table(keyEvents, ["time","action","detail","resources","army","tech"]);
      } else { console.log("⚠️ Ключевых событий не зафиксировано."); }
      const m = this.metrics();
      console.log(`💰 Финальная экономика: Ресурсы: ${m.resTotal}, Армия: ${m.aiArmy}, Технологий: Тир ${m.techLevel}`);
      console.groupEnd();
    },

    reset: function () {
      console.log("[GnnAI] 🧹 Сброс весов и очистка памяти...");
      WeightDB.isClosing = true;
      this.vars = []; this.targetVars = []; this.model = null; this.optimizer = null;
      this.replay = new RingBuffer(CFG.REPLAY_SIZE);
      if (WeightDB.db) { WeightDB.db.close(); WeightDB.db = null; }
      const req = indexedDB.deleteDatabase('GnnAI_Weights_DB');
      req.onsuccess = () => { console.log("[GnnAI] ✅ База данных удалена. Перезагрузка..."); WeightDB.isClosing = false; location.reload(); };
      req.onerror = () => { console.error("[GnnAI] ❌ Ошибка удаления БД, пробуем перезагрузку anyway"); WeightDB.isClosing = false; location.reload(); };
      req.onblocked = () => { console.warn("[GnnAI] ⚠️ Удаление заблокировано другой вкладкой? Перезагрузка..."); location.reload(); };
    },

generateVirtualNodes: function(nodes) {
  const virtualNodes = [];
  const enemyNodes = nodes.filter(n => n.valid && n.owner === "player");
  const aiNodes = nodes.filter(n => n.valid && n.owner === "ai");
  if (enemyNodes.length === 0) return virtualNodes;

  // 1. ЗОНЫ УГРОЗЫ: КАЖДАЯ ТУРЕЛЬ — СВОЙ ОТДЕЛЬНЫЙ КРУГ (даже если она всего 1!)
  const enemyTurrets = enemyNodes.filter(n => n.type && n.type.startsWith("turret"));
  const TURRET_RANGE = { turret: 250, turret2: 500, turret3: 450 };
  
  // Создаем зону угрозы для КАЖДОЙ увиденной турели отдельно
  enemyTurrets.forEach(turret => {
    const range = TURRET_RANGE[turret.type] || 250;
    const finalRadius = range + 30; // буфер 30px
    
    virtualNodes.push({
      obj: null,
      type: "threat_zone",
      owner: "player",
      x: turret.x,
      y: turret.y,
      hp: 0,
      valid: 1,
      isVirtual: true,
      virtualType: "threat",
      threatRadius: finalRadius,
      sourceTurret: turret.type,
      freshness: 1.0,
      isStale: false
    });
  });

  // 2. ФЛАНГОВЫЕ ТОЧКИ: поиск "тонких мест" и точек сбора
  // 🔥 ЯКОРЬ: база врага, а если её нет — центр масс вражеских турелей
  let anchor = enemyNodes.find(n => n.type && n.type.includes("base"));
  if (!anchor && enemyTurrets.length > 0) {
    anchor = {
      x: enemyTurrets.reduce((s, t) => s + t.x, 0) / enemyTurrets.length,
      y: enemyTurrets.reduce((s, t) => s + t.y, 0) / enemyTurrets.length
    };
  }

  if (anchor) {
    // Вычисляем максимальный радиус угрозы от центра
    const maxThreatR = virtualNodes
      .filter(v => v.virtualType === "threat")
      .reduce((mx, v) => {
        const d = Math.hypot(v.x - anchor.x, v.y - anchor.y) + v.threatRadius;
        return Math.max(mx, d);
      }, 0);

    const TURRET_RANGES = { turret: 250, turret2: 500, turret3: 450 };
    const candidates = [];
    const numAngles = 16; // Сканируем 16 направлений вокруг центра

    // 🔥 СКАНИРОВАНИЕ: ищем направления с наименьшим количеством угрожающих турелей
    for (let i = 0; i < numAngles; i++) {
      const angle = (i / numAngles) * Math.PI * 2;
      // Ищем точку чуть за пределами максимальной зоны поражения
      const searchDist = maxThreatR + 60; 
      const fx = anchor.x + Math.cos(angle) * searchDist;
      const fy = anchor.y + Math.sin(angle) * searchDist;

      // Считаем, сколько турелей "простреливают" эту конкретную точку
      let threatCount = 0;
      enemyTurrets.forEach(t => {
        const distToTurret = Math.hypot(fx - t.x, fy - t.y);
        const tRange = TURRET_RANGES[t.type] || 250;
        if (distToTurret <= tRange) {
          threatCount++;
        }
      });

      candidates.push({ x: fx, y: fy, threatCount, angle });
    }

    // 🔥 СОРТИРОВКА: сначала идут направления с наименьшей плотностью огня (самые "тонкие" места)
    candidates.sort((a, b) => a.threatCount - b.threatCount);

    // Берем топ-4 наименее защищенных направления
    const numToPlace = Math.min(4, candidates.length);
    for (let i = 0; i < numToPlace; i++) {
      const c = candidates[i];
      
      // 🔥 ЛОГИКА ТОЧЕК СБОРА (Staging Area):
      // Если даже в "самом тонком" месте есть угроза (threatCount > 0), 
      // мы отодвигаем точку еще дальше, чтобы это было безопасное место для накопления войск, а не путь обхода.
      const isStagingArea = c.threatCount > 0;
      const finalDist = isStagingArea ? (maxThreatR + 150) : (maxThreatR + 60);
      
      const sx = anchor.x + Math.cos(c.angle) * finalDist;
      const sy = anchor.y + Math.sin(c.angle) * finalDist;

      // Проверка границ карты
      const wW = typeof worldWidth !== 'undefined' ? worldWidth : 2000;
      const wH = typeof worldHeight !== 'undefined' ? worldHeight : 2000;
      if (sx < 50 || sy < 50 || sx > wW - 50 || sy > wH - 50) continue;

      virtualNodes.push({
        obj: null,
        type: "flank_point",
        owner: "neutral",
        x: sx,
        y: sy,
        hp: 0,
        valid: 1,
        isVirtual: true,
        virtualType: "flank",
        flankIndex: i,
        threatDensity: c.threatCount,     // Для отладки и логики ИИ
        isStagingArea: isStagingArea,     // 🔥 КЛЮЧЕВОЙ ФЛАГ
        freshness: 1.0,
        isStale: false
      });
    }
  }

  // 3. ТОЧКИ РАЗВЕДКИ если врагов мало
  if (enemyNodes.length < 5) {
    const aiBaseNode = aiNodes.find(n => n.type === "base");
    if (aiBaseNode) {
      [Math.PI/4, Math.PI*0.75, Math.PI*1.25, Math.PI*1.75].forEach(angle => {
        virtualNodes.push({
          obj: null,
          type: "recon_target",
          owner: "neutral",
          x: aiBaseNode.x + Math.cos(angle) * 400,
          y: aiBaseNode.y + Math.sin(angle) * 400,
          hp: 0,
          valid: 1,
          isVirtual: true,
          virtualType: "recon",
          freshness: 0.5,
          isStale: false
        });
      });
    }
  }

  return virtualNodes;
},

    findBestResourceCluster: function () {
        const res = gameState.resources.filter(r => r.amount > 20);
        let best = null, bestScore = 0;
        for (const r of res) {
            const covered = gameState.buildings.some(b =>
                b.owner === "ai" && b.type ==="warehouse" && Math.hypot(b.x - r.x, b.y - r.y) < 320);
            if (covered) continue;
            const density = res.filter(o => Math.hypot(o.x - r.x, o.y - r.y) < 250)
                               .reduce((s, o) => s + o.amount, 0);
            if (density > bestScore) { bestScore = density; best = r; }
        }
        return best;
    }
  };

  window.buildQueue = window.buildQueue || [];
  window.scheduleAIBuilding = function (type, x, y, delay = 0) {
    if (typeof canBuild === "function" && !canBuild(type)) return false;
    window.buildQueue.push({ 
      type, 
      x, 
      y, 
      plannedAt: performance.now(), 
      delay, 
      failCount: 0 
    });
    console.log(`[BUILD DEBUG] 📝 Запланировано: ${type} на (${x.toFixed(0)}, ${y.toFixed(0)})`);
    return true;
  };
  window.processBuildQueue = function () {
    const now = performance.now();
    for (let i = 0; i < window.buildQueue.length; i++) {
      const item = window.buildQueue[i];
      if (now - item.plannedAt >= item.delay) {
        if (typeof aiPlaceBuilding !== "function") { 
          console.error(`[BUILD DEBUG] ❌ КРИТИЧЕСКАЯ ОШИБКА: Функция aiPlaceBuilding НЕ НАЙДЕНА!`);
          window.buildQueue.splice(i, 1); i--; continue; 
        }
        const built = aiPlaceBuilding(item.type, item.x, item.y);
        if (built) {
          console.log(`[BUILD DEBUG] 🎉 УСПЕХ! ${item.type} построен на (${item.x}, ${item.y})`);
          window.buildQueue.splice(i, 1); i--;
        } else {
          // 🔥 УВЕЛИЧИВАЕМ СЧЕТЧИК НЕУДАЧ
          item.failCount = (item.failCount || 0) + 1;
          if (item.failCount >= 3) {
            console.error(`[BUILD DEBUG] ❌ КРИТИЧЕСКИЙ СБОЙ: Не удалось разместить ${item.type} на (${item.x}, ${item.y}) после 3 попыток. Вероятно, коллизия или недопустимая зона. Задача удалена из очереди, чтобы ИИ мог выбрать новые координаты.`);
            window.buildQueue.splice(i, 1); i--;
          } else {
            console.warn(`[BUILD DEBUG] ⚠️ ПРОВАЛ (${item.failCount}/3): aiPlaceBuilding вернул false для ${item.type}. Повторная попытка через 2 сек.`);
            item.plannedAt = now + 2000; 
          }
        }
      }
    }
  };

  async function startGnnGame() {
    if (typeof stopAllIntervals === "function") stopAllIntervals();
    if (window.__aiSaleQueueInterval) { clearInterval(window.__aiSaleQueueInterval); window.__aiSaleQueueInterval = null; }
    // Отключаем стандартную логику, чтобы не мешала
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
      if (el) { el.style.display = "none"; el.style.visibility ="hidden"; }
    });
    const gnnBtn = document.getElementById("gnnButton");
    if (gnnBtn) gnnBtn.style.display = "none";
    gameStarted = true; 
    gameMode = "gnn";
    if (typeof window.neuralAIActive !== "undefined") window.neuralAIActive = false;
    isPaused = false; playerId = "player"; opponentId = null;
    gameState.gameEnded = false;
    // Очистка состояния
    gameState.buildings = []; gameState.units = []; gameState.fragments = []; gameState.particles = [];
    gameState.resources = []; gameState.bullets = []; gameState.lasers = []; gameState.capturePoints = [];
    gameState.resourceTokens = []; gameState.recentBuilds = []; gameState.recentLosses = [];
    gameState.attackers = []; gameState.repairmen = []; gameState.defenders = [];
    gameState.playerResources = { gold: 100, silicon: 100, plasma: 50 };
    gameState.aiResources = { gold: 100, silicon: 100, plasma: 50 };
    gameState.playerScore = 0; selectedUnits = [];
    const m = 300;
	playerBase = new Building("base","player", m, m);
	aiBase = new Building("base","ai", worldWidth - m, worldHeight - m);
	playerBase.active = true; aiBase.active = true;
	gameState.buildings.push(playerBase, aiBase);
	// 🔥 ДИНАМИЧЕСКАЯ СИНХРОНИЗАЦИЯ РАЗМЕРА МИРА
	GnnAI.cfg.WORLD_WIDTH = typeof worldWidth !== 'undefined' ? worldWidth : 2000;
	GnnAI.cfg.WORLD_HEIGHT = typeof worldHeight !== 'undefined' ? worldHeight : 2000;
  
  // !!!генерация  ресурсов
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
    // ЗАПУСК ГЛАВНОГО ЦИКЛА
    requestAnimationFrame(gameLoop);
    console.log("[GnnAI] 🚀 Матч начат (v7.7)");
    setTimeout(() => {
      document.querySelectorAll('div').forEach(div => {
        if (div.style.zIndex >= 100 && div.offsetWidth > window.innerWidth * 0.5) {
           if (!div.id.includes('gnn-training') && div.tagName !== 'CANVAS') { div.style.display = 'none'; }
        }
      });
    }, 300);
    // 🔥 ФИКСИРУЕМ ТОЧКУ ОТСЧЁТА ДЛЯ ДЕЛЬТЫ СЕССИИ
    try {
      let l2Sum = 0;
      // 🔥 ИСПРАВЛЕНО: используем GnnAI.vars вместо this.vars
      for (const v of GnnAI.vars) {
        const data = v.dataSync();
        for (let i = 0; i < data.length; i++) {
          if (isFinite(data[i])) l2Sum += data[i] * data[i];
        }
      }
      // 🔥 ИСПРАВЛЕНО: сохраняем в GnnAI.sessionStartL2
      GnnAI.sessionStartL2 = Math.sqrt(l2Sum);
      console.log(`[GnnAI] 🎬 Старт матча. Точка отсчёта L2: ${GnnAI.sessionStartL2.toFixed(4)}`);
    } catch (e) {
      console.warn("[GnnAI] ⚠️ Не удалось зафиксировать точку отсчёта L2:", e);
      GnnAI.sessionStartL2 = 0;
    }
  }

  function addMenuButton() {
    const loading = document.getElementById("loadingScreen");
    if (!loading || document.getElementById("gnnButton")) return;
    const btn = document.createElement("button");
    btn.id = "gnnButton"; btn.innerText ="Графии v7.7";
    btn.style.cssText = "font-family: 'Orbitron', sans-serif; font-size: 18px; padding: 12px 28px; border: 2px solid #00ff99; color: #00ff99; background: rgba(0,255,120,0.08); border-radius: 50px; box-shadow: 0 0 15px rgba(0,255,120,0.5); cursor: pointer; transition: all 0.3s ease; z-index: 10; margin-top: 10px;";
    btn.onmouseenter = () => { btn.style.background = "rgba(0,255,120,0.2)"; btn.style.transform ="scale(1.05)"; };
    btn.onmouseleave = () => { btn.style.background = "rgba(0,255,120,0.08)"; btn.style.transform ="scale(1)"; };
    btn.onclick = startGnnGame;
    const neural = document.getElementById("neuralButton");
    if (neural && neural.parentNode === loading) neural.insertAdjacentElement("afterend", btn);
    else loading.appendChild(btn);
  }

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
  window.GnnAI = GnnAI;
  window.startGnnGame = startGnnGame;

  function createTrainingOverlay() {
    if (document.getElementById('gnn-training-overlay')) return;
    const overlay = document.createElement('div');
    overlay.id = 'gnn-training-overlay';
    overlay.style.cssText = `position: fixed; top: 10px; right: 10px; background: rgba(0, 0, 0, 0.8); color: #00ff99; font-family: monospace; font-size: 12px; padding: 12px; border-radius: 8px; border: 1px solid #00ff99; z-index: 9999; pointer-events: none;`;
    overlay.innerHTML = `<div style="font-weight:bold; margin-bottom:5px; color:#fff;">🧠 GNN AUTO-TRAINING</div> <div id="ov-episode">Episode: <span style="color:#fff">-</span></div> <div id="ov-winrate">Winrate: <span style="color:#fff">-</span></div> <div id="ov-action">Last: <span style="color:#87ceeb">-</span></div> <div id="ov-entropy">🎚️ Entropy: <span style="color:#fff">-</span></div> <div style="margin-top:5px; border-top:1px solid #00ff99; padding-top:5px;"> ⚔️ Army: <span id="ov-army" style="color:#ff6b6b">0</span> | 👷 Workers: <span id="ov-workers" style="color:#ffd93d">0</span> </div>`;
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
    document.getElementById('ov-action').innerHTML =  `Last: <span style="color:#87ceeb">${GnnAI.lastAction || 'init'}</span>` ;

    // 🔥 ОТОБРАЖЕНИЕ ДИНАМИЧЕСКОЙ ЭНТРОПИИ С ЦВЕТОВОЙ ИНДИКАЦИЕЙ
    const entropyCoef = typeof GnnAI.getEntropyCoef === 'function' ? GnnAI.getEntropyCoef() : 0.05;
    let entropyColor = '#ff6b6b';  // Красный —exploitation (низкая энтропия)
    let entropyPhase = '🎯 Exploit';
    if (entropyCoef >= 0.04) {
      entropyColor = '#6bcb77';  // Зелёный — активное исследование
      entropyPhase = '🔍 Explore';
    } else if (entropyCoef >= 0.02) {
      entropyColor = '#ffd93d';  // Жёлтый — переходная фаза
      entropyPhase = '🔄 Balance';
    }
    document.getElementById('ov-entropy').innerHTML = `🎚️ Entropy: <span style="color:${entropyColor}">${entropyCoef.toFixed(4)}</span> <span style="color:${entropyColor}; font-size:10px;">${entropyPhase}</span>`;

    document.getElementById('ov-army').innerText = m.aiArmy;
    document.getElementById('ov-workers').innerText = workers;
  };
    const _origRAF = window.requestAnimationFrame;
    let lastOverlayUpdate = 0;
    const OVERLAY_UPDATE_INTERVAL = 500; // Обновлять оверлей раз в 200ms вместо каждого кадра

    window.requestAnimationFrame = function(callback) {
      return _origRAF(function(ts) {
        if (window.gameStarted && !gameState.gameEnded) {
          // Обновляем оверлей только если прошло 200ms
          if (ts - lastOverlayUpdate > OVERLAY_UPDATE_INTERVAL) {
            window.updateTrainingOverlay();
            lastOverlayUpdate = ts;
          }
        }
        callback(ts);
      });
    };

  window.addEventListener("load", () => {
    if (typeof addMenuButton === "function") addMenuButton();
    if (typeof patchScheduler === "function") patchScheduler();
    console.log("[GnnAI] ✅ Система загружена и готова.");
    if (localStorage.getItem('gnn_auto_restart') === 'true') {
      console.log("[AutoStart] 🚀 Обнаружен режим авто-обучения. Ждем полной загрузки UI...");
      setTimeout(() => {
        console.log("[AutoStart] ⏱ Запуск GNN...");
        window.autoRestartEnabled = true;
        window.aiDifficulty = window.aiDifficulty || 0;
        createTrainingOverlay();
        if (typeof window.startGnnGame === "function") window.startGnnGame();
        else console.error("[AutoStart] ❌ Ошибка: функция startGnnGame не найдена!");
      }, 1500); 
    }
  });
// ВИЗУАЛИЗАЦИЯ GNN ГРАФА (С УПРАВЛЕНИЕМ ПАНЕЛЬЮ И СВЯЗЯМИ)
if (typeof window.showGnnGraph === 'undefined') window.showGnnGraph = true;
if (typeof window.showGnnLegend === 'undefined') window.showGnnLegend = true;
// ============================================
// 🔥 СОБЫТИЙНЫЕ ХУКИ ДЛЯ GNN
// Перехватываем damage/death/target-reached
// ============================================
window.GnnEventHooks = {
  // Вызывается при получении урона юнитом
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
    // Если источник — турель/база, помечаем тип угрозы
    if (source && source.type && source.type.startsWith("turret")) {
      unit.missionLog.hitByTurret = true;
    }
  },
  // Вызывается при нанесении урона юнитом
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
  // Вызывается при смерти юнита
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
  // Вызывается при достижении цели (attack-команда)
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
  // Вызывается при уничтожении цели
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
})();