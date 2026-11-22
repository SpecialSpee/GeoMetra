// ============================================================
// trainingBot.js v2 — С автовосстановлением, ремонтниками и реакцией
// ============================================================
(function () {
  "use strict";
  if (window.TrainingBot) {
    return;
  }
    window.OPPONENT_PROFILES = [
    { name: "Rush", aggression: 0.9, eco: 0.5, expand: 0.5 },
  ];
  const TrainingBot = {
    active: false,
    lastActionTime: 0,
    phase: 0,
    threatLog: [],
    
    phases: [
      { name: "Economy Rush", duration: 80, action: "buildEconomy" },       
      { name: "Army & Defense", duration: 80, action: "buildArmy" },   
      { name: "Tech Tier 2", duration: 80, action: "techUp2" },        
      { name: "Mid Game Army", duration: 50, action: "buildMidArmy" }, 
      { name: "Tech Tier 3", duration: 80, action: "techUp3" },        
      { name: "Late Game Waves", duration: 9999, action: "largeAttacks" } 
    ],
    
    // 🎯 ЦЕЛЕВЫЕ КОЛИЧЕСТВА ЗДАНИЙ ПО ФАЗАМ (для автовосстановления)
    buildingGoalsByPhase: [
      { warehouse: 2, repairWorkshop: 1, barracks: 0, beacon: 0, turret: 0, base2: 0, barracks2: 0, base3: 0, barracks3: 0 },
      { warehouse: 3, repairWorkshop: 1, barracks: 2, beacon: 1, turret: 2, base2: 0, barracks2: 0, base3: 0, barracks3: 0 },
      { warehouse: 4, repairWorkshop: 1, barracks: 2, beacon: 1, turret: 3, base2: 1, barracks2: 1, base3: 0, barracks3: 0 },
      { warehouse: 4, repairWorkshop: 2, barracks: 2, beacon: 2, turret: 5, base2: 1, barracks2: 2, base3: 0, barracks3: 0 },
      { warehouse: 5, repairWorkshop: 2, barracks: 2, beacon: 2, turret: 6, base2: 1, barracks2: 2, base3: 1, barracks3: 1 },
      { warehouse: 5, repairWorkshop: 3, barracks: 3, beacon: 3, turret: 8, base2: 1, barracks2: 3, base3: 1, barracks3: 2 }
    ],
    
    teachAction: function(actionName, intent) {
      if (!window.GnnAI || !window.gameState) return;
      const fakeState = window.GnnAI.buildGraphState(); 
      if (!fakeState) return;
      const actionIndex = window.AIDX ? window.AIDX[actionName] : -1;
      if (actionIndex === -1) return;
      window.GnnAI.registerAction(actionName, fakeState, intent, actionIndex, true);
      const lastEntry = window.GnnAI.replay.buffer[(window.GnnAI.replay.head - 1 + window.GnnAI.replay.capacity) % window.GnnAI.replay.capacity];
      if (lastEntry) {
        lastEntry.reward += 10.0;
      }
    },
    
    checkAndRestart: async function () {
      if (!gameState.gameEnded) return;
      console.log("[TrainingBot] 🏁 Игра завершена. Подготовка к перезапуску...");
      if (window.GnnAI && typeof window.GnnAI.saveWeights === "function") {
        try {
          await window.GnnAI.saveWeights();
          console.log("[TrainingBot] ✅ Веса сохранены.");
        } catch (e) {
          console.error("[TrainingBot] ❌ Ошибка сохранения:", e);
        }
      }
      await new Promise(r => setTimeout(r, 500));
      localStorage.setItem('gnn_auto_restart', 'true');
      console.log("[TrainingBot] 🔄 Перезагрузка...");
      window.location.reload();
    },
    
    init: function () {
      this.active = true;
      this.phase = 0;
      this.startTime = performance.now();
      this.lastActionTime = performance.now();
      this.threatLog = [];
      this.profile = window.OPPONENT_PROFILES[Math.floor(Math.random() * window.OPPONENT_PROFILES.length)];
      console.log(`[TrainingBot] 🎭 Профиль: ${this.profile.name} (Agg: ${this.profile.aggression}, Eco: ${this.profile.eco})`);
      
      // 🔥 Устанавливаем перехват урона
      this.installDamageHook();
    },
    
    // 🔥 ПЕРЕХВАТ УРОНА: подписываемся на хуки урона
    installDamageHook: function() {
      const self = this;
      
      // 1. Подписка на GNN-хуки (основной путь)
      if (window.GnnEventHooks) {
        const orig = window.GnnEventHooks.onUnitDamaged;
        window.GnnEventHooks.onUnitDamaged = function(unit, damage, source) {
          if (unit && unit.owner === "player" && source && source.owner !== "player" && damage > 0) {
            self.handleThreat(unit, source, damage);
          }
          if (typeof orig === "function") return orig.call(this, unit, damage, source);
        };
      }
      
      // 2. Оборачиваем onDamage (для не-GNN режима)
      if (typeof window.onDamage === "function" && !window.onDamage.__trainingBotHooked) {
        const origOnDamage = window.onDamage;
        window.onDamage = function(entity, damage, source) {
          if (entity && entity.owner === "player" && source && source.owner !== "player") {
            self.handleThreat(entity, source, damage);
          }
          return origOnDamage(entity, damage, source);
        };
        window.onDamage.__trainingBotHooked = true;
      }
      
      console.log("[TrainingBot] 🛡️ Перехват урона установлен.");
    },
    
    // 🔥 ОБРАБОТКА УГРОЗЫ
    handleThreat: function(victim, source, damage) {
      if (!source || !victim) return;
      
      // Лог угрозы (оставляем последние 20)
      this.threatLog.push({
        time: performance.now(),
        victim: victim.type,
        victimPos: { x: victim.x, y: victim.y },
        source: source.type,
        sourceId: source.id,
        damage: damage
      });
      if (this.threatLog.length > 20) this.threatLog.shift();
      
      // Немедленная контратака ближайшими свободными бойцами
      this.counterAttack(victim, source);
      
      // Если атакуют здание — массовая мобилизация
      const isBuilding = (typeof Building !== "undefined" && victim instanceof Building) || 
                         (victim.type && typeof victim.type === "string" && 
                          ["barracks","barracks2","barracks3","warehouse","repairWorkshop","turret","turret2","turret3","base","base2","base3","beacon"].includes(victim.type));
      if (isBuilding) {
        this.massMobilize(victim);
      }
    },
    
    // ⚔️ Немедленная контратака агрессора
    counterAttack: function(victim, aggressor) {
      if (!aggressor || aggressor.health <= 0) return;
      
      const freeUnits = gameState.units.filter(u => 
        u.owner === "player" && 
        ["fighter", "assault", "elite"].includes(u.type) &&
        u.health > 0 &&
        !u.isRetreating &&
        (!u.commandQueue || u.commandQueue.length === 0) &&
        Math.hypot(u.x - victim.x, u.y - victim.y) < 600
      );
      
      const count = Math.min(freeUnits.length, Math.floor(3 * this.profile.aggression) + 1);
      freeUnits.slice(0, count).forEach(u => {
        u.suspendedQueue = null;
        u.commandQueue = [{ type: "attack", target: aggressor }];
        u.target = aggressor;
        if (typeof processCommandQueue === "function") processCommandQueue(u);
      });
    },
    
    // 🛡️ Массовая мобилизация при атаке здания
    massMobilize: function(victimBuilding) {
      const defenders = gameState.units.filter(u => 
        u.owner === "player" && 
        ["fighter", "assault", "elite"].includes(u.type) &&
        u.health > 0 &&
        !u.isRetreating &&
        (!u.commandQueue || u.commandQueue.length === 0)
      );
      
      const count = Math.ceil(defenders.length * 0.5);
      defenders.slice(0, count).forEach(u => {
        u.suspendedQueue = null;
        u.commandQueue = [
          { type: "move", x: victimBuilding.x + (Math.random()-0.5)*80, y: victimBuilding.y + (Math.random()-0.5)*80 },
        ];
        if (typeof processCommandQueue === "function") processCommandQueue(u);
      });
    },
    
    stop: function () {
      this.active = false;
    },

    tick: async function () {
      if (!this.active || !gameStarted || gameMode !== "gnn") {
        if (gameState.gameEnded) {
          await this.checkAndRestart();
        }
        return; 
      }
      
      const now = performance.now();
      const gameTimeSec = (now - this.startTime) / 500; 
      
      let accumulatedTime = 0;
      for (let i = 0; i < this.phases.length; i++) {
        accumulatedTime += this.phases[i].duration;
        if (gameTimeSec < accumulatedTime) {
          this.phase = i;
          break;
        }
      }

      if (now - this.lastActionTime < 200) return; 
      this.lastActionTime = now;

      // 🔄 ПОСТОЯННЫЕ ЗАДАЧИ (выполняются каждый тик независимо от фазы)
      this.restoreDestroyedBuildings();
      this.hireWorkersEverywhere();
      this.hireRepairmen();

      const action = this.phases[this.phase].action;
      this[action]();
    },
    
    // 🔄 ВОССТАНОВЛЕНИЕ УНИЧТОЖЕННЫХ ЗДАНИЙ
    restoreDestroyedBuildings: function() {
      const goals = this.buildingGoalsByPhase[this.phase] || {};
      const inQueue = (window.buildQueue || []).map(q => q.type);
      
      for (const [type, goalCount] of Object.entries(goals)) {
        if (goalCount <= 0) continue;
        
        const currentCount = gameState.buildings.filter(b => b.owner === "player" && b.type === type).length;
        const queued = inQueue.filter(t => t === type).length;
        const missing = goalCount - currentCount - queued;
        
        if (missing > 0) {
          const costKey = type.toUpperCase() + "_COST";
          const cost = typeof window[costKey] !== "undefined" ? window[costKey] : null;
          
          if (cost && typeof canSpendResources === "function" && canSpendResources(cost, "player")) {
            const pos = this.findBuildPos(type);
            if (pos) {
              if (typeof placeBuilding === "function") {
                placeBuilding(pos.x, pos.y, type, "player");
              } else if (typeof scheduleAIBuilding === "function") {
                scheduleAIBuilding(type, pos.x, pos.y, 0);
              }
              this.teachAction("restore_" + type, { type: "build", buildingType: type });
              console.log(`[TrainingBot] 🔧 Восстанавливаю ${type} (было ${currentCount}, цель ${goalCount})`);
            }
          }
        }
      }
    },
    
    // 👷 НАЙМ РАБОЧИХ НА ВСЕ СКЛАДЫ (до maxDeliveryWorkers на каждом)
    hireWorkersEverywhere: function() {
      const warehouses = gameState.buildings.filter(b => 
        b.owner === "player" && 
        b.type === "warehouse" && 
        b.active && 
        (b.workers || 0) < (b.maxDeliveryWorkers || 5)
      );
      
      if (warehouses.length === 0) return;
      
      for (const wh of warehouses) {
        const slotsAvailable = (wh.maxDeliveryWorkers || 5) - (wh.workers || 0);
        for (let i = 0; i < slotsAvailable; i++) {
          if (typeof canSpendResources === "function" && canSpendResources(WORKER_COST, "player")) {
            if (typeof hireWorkerForPlayer === "function") {
              hireWorkerForPlayer(wh);
              this.teachAction("hireWorker", { type: "hire", unitType: "worker" });
            } else {
              return;
            }
          } else {
            return; // Нет ресурсов — выходим
          }
        }
      }
    },
    
    // 🔧 НАЙМ РЕМОНТНИКОВ НА ВСЕ РЕМ.МАСТЕРСКИЕ
    hireRepairmen: function() {
      const workshops = gameState.buildings.filter(b => 
        b.owner === "player" && 
        b.type === "repairWorkshop" && 
        b.active &&
        (b.repairman || 0) < (b.capacity || 3)
      );
      
      if (workshops.length === 0) return;
      
      for (const ws of workshops) {
        const slotsAvailable = (ws.capacity || 3) - (ws.repairman || 0);
        for (let i = 0; i < slotsAvailable; i++) {
          if (typeof canSpendResources === "function" && canSpendResources(REPAIRMAN_COST, "player")) {
            if (typeof hireRepairmanForPlayer === "function") {
              hireRepairmanForPlayer(ws);
              this.teachAction("hireRepairman", { type: "hire", unitType: "repairman" });
            } else {
              return;
            }
          } else {
            return;
          }
        }
      }
    },
    
    buildEconomy: function () {
      const warehouses = gameState.buildings.filter(b => b.owner === "player" && b.type === "warehouse").length;
      const workshops = gameState.buildings.filter(b => b.owner === "player" && b.type === "repairWorkshop").length;

      if (warehouses < 4 && typeof canSpendResources === "function" && canSpendResources(WAREHOUSE_COST, "player")) {
        const pos = this.findBuildPos("warehouse");
        if (pos) { 
          placeBuilding(pos.x, pos.y, "warehouse", "player"); 
          this.teachAction("build_warehouse", { type: "build", buildingType: "warehouse" });
        }
      } 
      
      if (workshops === 0 && typeof canSpendResources === "function" && canSpendResources(REPAIR_WORKSHOP_COST, "player")) {
        const pos = this.findBuildPos("repairWorkshop");
        if (pos) { 
          placeBuilding(pos.x, pos.y, "repairWorkshop", "player"); 
          this.teachAction("build_repair", { type: "build", buildingType: "repairWorkshop" });
        }
      } 
    },

    buildArmy: function () {
      const barracks = gameState.buildings.filter(b => b.owner === "player" && b.type === "barracks").length;
      const barracksInQueue = (window.buildQueue || []).filter(q => q.type === "barracks").length;
      const beacons = gameState.buildings.filter(b => b.owner === "player" && b.type === "beacon").length;
      const turrets = gameState.buildings.filter(b => b.owner === "player" && b.type?.startsWith("turret")).length;
      const fighters = gameState.units.filter(u => u.owner === "player" && u.type === "fighter").length;
      const maxTurrets = beacons * 3;

      if (barracks === 0 && barracksInQueue === 0) {
        if (typeof canSpendResources === "function" && canSpendResources(BARRACKS_COST, "player")) {
          const pos = this.findBuildPos("barracks");
          if (pos) {
            if (typeof placeBuilding === "function") {
              placeBuilding(pos.x, pos.y, "barracks", "player");
              this.teachAction("build_barracks", { type: "build", buildingType: "barracks" });
            }
          }
        }
      }
      
      if (beacons === 0 && typeof canSpendResources === "function" && canSpendResources(BEACON_COST, "player")) {
        const pos = this.findBuildPos("beacon");
        if (pos) { 
          typeof placeBuilding === "function" ? placeBuilding(pos.x, pos.y, "beacon", "player") : null;
          this.teachAction("build_beacon", { type: "build", buildingType: "beacon" });
        }
      } 
      
      if (turrets < maxTurrets && turrets < 3 && typeof canSpendResources === "function" && canSpendResources(TURRET_COST, "player")) {
        const pos = this.findBuildPos("turret");
        if (pos) { 
          typeof placeBuilding === "function" ? placeBuilding(pos.x, pos.y, "turret", "player") : null;
        }
      } 
      
      if (fighters < 10) {
        this.hireFighter();
      }
    },
    
    techUp2: function () {
      const hasBeacon = gameState.buildings.some(b => b.owner === "player" && b.type === "beacon");
      const hasBase2 = gameState.buildings.some(b => b.owner === "player" && b.type === "base2");
      const hasBarracks2 = gameState.buildings.some(b => b.owner === "player" && b.type === "barracks2");

      if (!hasBeacon && typeof canSpendResources === "function" && canSpendResources(BEACON_COST, "player")) {
        const pos = this.findBuildPos("beacon");
        if (pos) { placeBuilding(pos.x, pos.y, "beacon", "player"); }
      } 
      if (hasBeacon && !hasBase2 && typeof canSpendResources === "function" && canSpendResources(BASE2_COST, "player")) {
        const pos = this.findBuildPos("base2");
        if (pos) { placeBuilding(pos.x, pos.y, "base2", "player"); }
      } 
      if (hasBase2 && !hasBarracks2 && typeof canSpendResources === "function" && canSpendResources(BARRACKS2_COST, "player")) {
        const pos = this.findBuildPos("barracks2");
        if (pos) { placeBuilding(pos.x, pos.y, "barracks2", "player"); }
      }
      if (hasBarracks2) this.hireAssault();
    },

    buildMidArmy: function () {
      const beacons = gameState.buildings.filter(b => b.owner === "player" && b.type === "beacon").length;
      const turrets = gameState.buildings.filter(b => b.owner === "player" && b.type?.startsWith("turret")).length;
      const assaults = gameState.units.filter(u => u.owner === "player" && u.type === "assault").length;
      const hasBarracks2 = gameState.buildings.some(b => b.owner === "player" && b.type === "barracks2");
      const maxTurrets = beacons * 3;

      if (turrets < maxTurrets && turrets < 6 && typeof canSpendResources === "function" && canSpendResources(TURRET_COST, "player")) {
        const pos = this.findBuildPos("turret");
        if (pos) { placeBuilding(pos.x, pos.y, "turret", "player"); }
      } 
      if (turrets >= maxTurrets && turrets < 6 && beacons < 2 && typeof canSpendResources === "function" && canSpendResources(BEACON_COST, "player")) {
        const pos = this.findBuildPos("beacon");
        if (pos) { placeBuilding(pos.x, pos.y, "beacon", "player"); }
      }
      if (hasBarracks2 && assaults < 5) this.hireAssault();
    },

    techUp3: function () {
      const hasBase2 = gameState.buildings.some(b => b.owner === "player" && b.type === "base2");
      const hasBarracks2 = gameState.buildings.some(b => b.owner === "player" && b.type === "barracks2");
      const hasBase3 = gameState.buildings.some(b => b.owner === "player" && b.type === "base3");
      const hasBarracks3 = gameState.buildings.some(b => b.owner === "player" && b.type === "barracks3");

      if (hasBase2 && hasBarracks2 && !hasBase3 && typeof canSpendResources === "function" && canSpendResources(BASE3_COST, "player")) {
        const pos = this.findBuildPos("base3");
        if (pos) { placeBuilding(pos.x, pos.y, "base3", "player"); }
      } 
      if (hasBase3 && !hasBarracks3 && typeof canSpendResources === "function" && canSpendResources(BARRACKS3_COST, "player")) {
        const pos = this.findBuildPos("barracks3");
        if (pos) { placeBuilding(pos.x, pos.y, "barracks3", "player"); }
      }
      if (hasBarracks3) this.hireElite();
    },

    largeAttacks: function () {
      const army = gameState.units.filter(u => u.owner === "player" && ["fighter", "assault", "elite"].includes(u.type) && u.health > 0 && (!u.commandQueue || u.commandQueue.length === 0));
      const elites = gameState.units.filter(u => u.owner === "player" && u.type === "elite").length;
      const hasBarracks3 = gameState.buildings.some(b => b.owner === "player" && b.type === "barracks3");

      if (hasBarracks3 && elites < 3) {
        this.hireElite();
      } else {
        this.hireAssault();
      }

      const attackThreshold = Math.max(4, Math.floor(12 * (1.2 - this.profile.aggression)));
      if (army.length >= attackThreshold) {
        this.sendAttackGroup(army.slice(0, Math.floor(10 * this.profile.aggression) + 2));
      }
    },

    hireFighter: function () {
      for (let i = 0; i < 3; i++) {
        const barracks = gameState.buildings.find(b => b.owner === "player" && b.type === "barracks" && b.active);
        if (barracks && typeof canSpendResources === "function" && canSpendResources(FIGHTER_COST, "player") && typeof hireFighterForPlayer === "function") {
          hireFighterForPlayer(barracks);
          this.teachAction("hireFighter", { type: "hire", unitType: "fighter" });
        } else { break; }
      }
    },

    hireAssault: function () {
      for (let i = 0; i < 3; i++) {
        const barracks2 = gameState.buildings.find(b => b.owner === "player" && b.type === "barracks2" && b.active);
        if (barracks2 && typeof canSpendResources === "function" && canSpendResources(ASSAULT_COST, "player") && typeof hireAssaultForPlayer === "function") {
          hireAssaultForPlayer(barracks2);
          this.teachAction("hireAssault", { type: "hire", unitType: "assault" });
        } else { break; }
      }
    },

    hireElite: function () {
      for (let i = 0; i < 2; i++) {
        const barracks3 = gameState.buildings.find(b => b.owner === "player" && b.type === "barracks3" && b.active);
        if (barracks3 && typeof canSpendResources === "function" && canSpendResources(ELITE_COST, "player") && typeof hireEliteForPlayer === "function") {
          hireEliteForPlayer(barracks3);
          this.teachAction("hireElite", { type: "hire", unitType: "elite" });
        } else { break; }
      }
    },

    sendAttackGroup: function (attackers) {
      if (!window.aiBase) return;
      const target = window.aiBase;
      
      attackers.forEach(u => {
        // 🔥 1. ПОЛНЫЙ СБРОС: Очищаем всё, чтобы юнит забыл старые прямые пути
        u.commandQueue = [];
        u.target = null;
        u.moveTarget = null;
        u.pathWaypoints = null;
        u.currentWaypointIndex = 0;
        
        // 🔥 2. ЦЕЛЬ С РАЗБРОСОМ: Атакуем не в одну пиксельную точку, а в зону вокруг базы
        const offsetX = (Math.random() - 0.5) * 200;
        const offsetY = (Math.random() - 0.5) * 200;
        
        // 🔥 3. НОВАЯ ОЧЕРЕДЬ: Сначала движемся (через A*), потом атакуем
        u.commandQueue = [
          { type: "move", x: target.x + offsetX, y: target.y + offsetY },
          { type: "attack", target: target }
        ];
        
        // 🔥 4. ЗАПУСК: processCommandQueue сам вызовет moveUnit -> findPath
        if (typeof processCommandQueue === "function") {
          processCommandQueue(u);
        }
      });
      
      console.log(`[TrainingBot] ⚔️ Отправлено в атаку: ${attackers.length} юнитов`);
    },

    findBuildPos: function (type) {
      const anchor = playerBase;
      if (!anchor) return null;
      for (let i = 0; i < 80; i++) {
        const angle = Math.random() * Math.PI * 2;
        const r = 100 + Math.random() * 300;
        const x = anchor.x + Math.cos(angle) * r;
        const y = anchor.y + Math.sin(angle) * r;
        
        if (x < 60 || y < 60 || x > worldWidth - 60 || y > worldHeight - 60) continue;
        
        const dims = { warehouse: [40, 30], repairWorkshop: [40, 30], barracks: [50, 30], turret: [20, 20], beacon: [40, 50], base2: [55, 40], base3: [55, 40], barracks2: [50, 30], barracks3: [50, 30] }[type] || [30, 30];
        const rect = { left: x - dims[0] / 2, top: y - dims[1] / 2, right: x + dims[0] / 2, bottom: y + dims[1] / 2 };
        
        let bad = false;
        for (const b of gameState.buildings) {
          const br = { left: b.x - b.width / 2 - 10, top: b.y - b.height / 2 - 10, right: b.x + b.width / 2 + 10, bottom: b.y + b.height / 2 + 10 };
          if (typeof rectsOverlap === "function" && rectsOverlap(rect, br)) { bad = true; break; }
        }
        if (!bad) return { x, y };
      }
      return null;
    }
  };
  window.TrainingBot = TrainingBot;
  window.startTrainingBot = function () { TrainingBot.init(); };
  window.stopTrainingBot = function () { TrainingBot.stop(); };
  const origGameLoop = window.gameLoop;
  if (typeof origGameLoop === "function") {
    window.gameLoop = function (timestamp) {
      if (TrainingBot.active) TrainingBot.tick();
      origGameLoop(timestamp);
    };
  } else {
    setInterval(() => { if (TrainingBot.active) TrainingBot.tick(); }, 200);
  }
  console.log("[TrainingBot] 🤖 v2 активен: восстановление + ремонтники + реакция на атаку.");
})();