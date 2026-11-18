// ============================================================
// trainingBot.js — Сверхбыстрый и агрессивный тренировочный бот
// С ВСТРОЕННЫМ АВТО-РЕСТАРТОМ ДЛЯ НЕПРЕРЫВНОГО ОБУЧЕНИЯ
// ============================================================
(function () {
  "use strict";

  if (window.TrainingBot) {
    return;
  }
	
  // 🔥 PBT: Профили противников для эволюционного обучения
  window.OPPONENT_PROFILES = [
    { name: "Rush", aggression: 0.9, eco: 0.5, expand: 0.5 },
    //{ name: "Turtle", aggression: 0.2, eco: 0.9, expand: 0.4 },
    //{ name: "Balanced", aggression: 0.7, eco: 0.6, expand: 0.6 },
    //{ name: "Macro", aggression: 0.4, eco: 0.8, expand: 0.8 }
  ];

  const TrainingBot = {
    active: false,
    lastActionTime: 0,
    phase: 0,
    
    // 🔥 УСКОРЕНИЕ: Фазы сокращены в 2-3 раза
    phases: [
      { name: "Economy Rush", duration: 80, action: "buildEconomy" },       
      { name: "Army & Defense", duration: 80, action: "buildArmy" },   
      { name: "Tech Tier 2", duration: 80, action: "techUp2" },        
      { name: "Mid Game Army", duration: 50, action: "buildMidArmy" }, 
      { name: "Tech Tier 3", duration: 80, action: "techUp3" },        
      { name: "Late Game Waves", duration: 9999, action: "largeAttacks" } 
    ],
	  
    // 🔥 ФУНКЦИЯ-УЧИТЕЛЬ: Передает действие бота в мозг ИИ
    teachAction: function(actionName, intent) {
      if (!window.GnnAI || !window.gameState) return;
      
      const fakeState = window.GnnAI.buildGraphState(); 
      if (!fakeState) return;

      const actionIndex = window.AIDX ? window.AIDX[actionName] : -1;
      if (actionIndex === -1) return;

      window.GnnAI.registerAction(actionName, fakeState, intent, actionIndex, true); // true = isExpert
      
      const lastEntry = window.GnnAI.replay.buffer[(window.GnnAI.replay.head - 1 + window.GnnAI.replay.capacity) % window.GnnAI.replay.capacity];
      if (lastEntry) {
        lastEntry.reward += 10.0; // Огромный бонус за копирование учителя (Behavior Cloning)
      }
    },

    // 🔥 НОВОЕ: Проверка конца игры и авто-перезапуск
    checkAndRestart: async function () {
      if (!gameState.gameEnded) return;
      
      console.log("[TrainingBot] 🏁 Игра завершена. Подготовка к перезапуску...");
      
      // 1. Сохраняем веса GNN перед перезагрузкой
      if (window.GnnAI && typeof window.GnnAI.saveWeights === "function") {
        try {
          await window.GnnAI.saveWeights();
          console.log("[TrainingBot] ✅ Веса GNN успешно сохранены в IndexedDB.");
        } catch (e) {
          console.error("[TrainingBot] ❌ Ошибка сохранения весов:", e);
        }
      }

      // 2. Даем браузеру 500мс на завершение транзакции IndexedDB
      await new Promise(r => setTimeout(r, 500));

      // 3. Устанавливаем флаг авто-перезапуска (чтобы 09-ui.js подхватил его)
      localStorage.setItem('gnn_auto_restart', 'true');
      
      // 4. Перезагружаем страницу для 100% чистой новой игры
      console.log("[TrainingBot] 🔄 Перезагрузка страницы для новой игры...");
      window.location.reload();
    },

    init: function () {
      this.active = true;
      this.phase = 0;
      this.startTime = performance.now();
      this.lastActionTime = performance.now();
      this.profile = window.OPPONENT_PROFILES[Math.floor(Math.random() * window.OPPONENT_PROFILES.length)];
      console.log(`[TrainingBot] 🎭 Загружен профиль: ${this.profile.name} (Agg: ${this.profile.aggression}, Eco: ${this.profile.eco})`);
    },
	  
    stop: function () {
      this.active = false;
    },

    // 🔥 ИЗМЕНЕНО: Теперь перехватывает gameState.gameEnded
    tick: async function () {
      // Если игра не запущена или режим не GNN
      if (!this.active || !gameStarted || gameMode !== "gnn") {
        // НО если игра закончилась, запускаем процедуру рестарта!
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

      // 🔥 УСКОРЕНИЕ: Действуем каждые 200 мс
      if (now - this.lastActionTime < 200) return; 
      this.lastActionTime = now;

      const action = this.phases[this.phase].action;
      this[action]();
    },
	  
    buildEconomy: function () {
      const warehouses = gameState.buildings.filter(b => b.owner === "player" && b.type === "warehouse").length;
      const workshops = gameState.buildings.filter(b => b.owner === "player" && b.type === "repairWorkshop").length;
      const workers = gameState.units.filter(u => u.owner === "player" && u.type === "worker").length;

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
      
      const targetWorkers = Math.floor(15 * this.profile.eco);
      if (workers < targetWorkers) {
        this.hireWorker();
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
            } else if (typeof window.scheduleAIBuilding === "function") {
              window.scheduleAIBuilding("barracks", pos.x, pos.y, 0);
              this.teachAction("build_barracks", { type: "build", buildingType: "barracks" });
            }
          }
        }
      }
      
      if (beacons === 0 && typeof canSpendResources === "function" && canSpendResources(BEACON_COST, "player")) {
        const pos = this.findBuildPos("beacon");
        if (pos) { 
          typeof placeBuilding === "function" ? placeBuilding(pos.x, pos.y, "beacon", "player") : window.scheduleAIBuilding("beacon", pos.x, pos.y, 0); 
          this.teachAction("build_beacon", { type: "build", buildingType: "beacon" });
        }
      } 
      
      if (turrets < maxTurrets && turrets < 3 && typeof canSpendResources === "function" && canSpendResources(TURRET_COST, "player")) {
        const pos = this.findBuildPos("turret");
        if (pos) { 
          typeof placeBuilding === "function" ? placeBuilding(pos.x, pos.y, "turret", "player") : window.scheduleAIBuilding("turret", pos.x, pos.y, 0); 
        }
      } 
      
      if (fighters < 15) {
        this.hireFighter();
      }
    },
												 
    techUp2: function () {
      const hasBeacon = gameState.buildings.some(b => b.owner === "player" && b.type === "beacon");
      const hasBase2 = gameState.buildings.some(b => b.owner === "player" && b.type === "base2");
      const hasBarracks2 = gameState.buildings.some(b => b.owner === "player" && b.type === "barracks2");

      if (!hasBeacon && typeof canSpendResources === "function" && canSpendResources(BEACON_COST, "player")) {
        const pos = this.findBuildPos("beacon");
        if (pos) { 
          placeBuilding(pos.x, pos.y, "beacon", "player"); 
          this.teachAction("build_beacon", { type: "build", buildingType: "beacon" });
        }
      } 
      
      if (hasBeacon && !hasBase2 && typeof canSpendResources === "function" && canSpendResources(BASE2_COST, "player")) {
        const pos = this.findBuildPos("base2");
        if (pos) { 
          placeBuilding(pos.x, pos.y, "base2", "player"); 
          this.teachAction("build_base2", { type: "build", buildingType: "base2" });
        }
      } 
      
      if (hasBase2 && !hasBarracks2 && typeof canSpendResources === "function" && canSpendResources(BARRACKS2_COST, "player")) {
        const pos = this.findBuildPos("barracks2");
        if (pos) { 
          placeBuilding(pos.x, pos.y, "barracks2", "player"); 
          this.teachAction("build_barracks2", { type: "build", buildingType: "barracks2" });
        }
      }
      
      if (hasBarracks2) {
        this.hireAssault();
      }
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
      
      if (hasBarracks2 && assaults < 15) {
        this.hireAssault();
      }
    },

    techUp3: function () {
      const hasBase2 = gameState.buildings.some(b => b.owner === "player" && b.type === "base2");
      const hasBarracks2 = gameState.buildings.some(b => b.owner === "player" && b.type === "barracks2");
      const hasBase3 = gameState.buildings.some(b => b.owner === "player" && b.type === "base3");
      const hasBarracks3 = gameState.buildings.some(b => b.owner === "player" && b.type === "barracks3");

      if (hasBase2 && hasBarracks2 && !hasBase3 && typeof canSpendResources === "function" && canSpendResources(BASE3_COST, "player")) {
        const pos = this.findBuildPos("base3");
        if (pos) { 
          placeBuilding(pos.x, pos.y, "base3", "player"); 
          this.teachAction("build_base3", { type: "build", buildingType: "base3" });
        }
      } 
      
      if (hasBase3 && !hasBarracks3 && typeof canSpendResources === "function" && canSpendResources(BARRACKS3_COST, "player")) {
        const pos = this.findBuildPos("barracks3");
        if (pos) { 
          placeBuilding(pos.x, pos.y, "barracks3", "player"); 
          this.teachAction("build_barracks3", { type: "build", buildingType: "barracks3" });
        }
      }
      
      if (hasBarracks3) {
        this.hireElite();
      }
    },

    largeAttacks: function () {
      const army = gameState.units.filter(u => u.owner === "player" && ["fighter", "assault", "elite"].includes(u.type) && u.health > 0 && (!u.commandQueue || u.commandQueue.length === 0));
      const elites = gameState.units.filter(u => u.owner === "player" && u.type === "elite").length;
      const hasBarracks3 = gameState.buildings.some(b => b.owner === "player" && b.type === "barracks3");

      if (hasBarracks3 && elites < 8) {
        this.hireElite();
      } else {
        this.hireAssault();
      }

      const attackThreshold = Math.max(4, Math.floor(12 * (1.2 - this.profile.aggression)));
      if (army.length >= attackThreshold) {
        this.sendAttackGroup(army.slice(0, Math.floor(10 * this.profile.aggression) + 2));
      }
    },

    hireWorker: function () {
      for (let i = 0; i < 3; i++) {
        const warehouse = gameState.buildings.find(b => b.owner === "player" && b.type === "warehouse" && b.active && (b.workers || 0) < (b.maxDeliveryWorkers || 5));
        if (warehouse && typeof canSpendResources === "function" && canSpendResources(WORKER_COST, "player") && typeof hireWorkerForPlayer === "function") {
          hireWorkerForPlayer(warehouse);
          this.teachAction("hireWorker", { type: "hire", unitType: "worker" });
        } else { break; }
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
      const target = aiBase;
      attackers.forEach(u => {
        u.commandQueue = [{ type: "move", x: target.x + (Math.random()-0.5)*100, y: target.y + (Math.random()-0.5)*100 }, { type: "attack", target: target }];
        if (typeof processCommandQueue === "function") processCommandQueue(u);
      });
    },

    findBuildPos: function (type) {
      const anchor = playerBase;
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

  // Интеграция с gameLoop
  const origGameLoop = window.gameLoop;
  if (typeof origGameLoop === "function") {
    window.gameLoop = function (timestamp) {
      if (TrainingBot.active) TrainingBot.tick();
      origGameLoop(timestamp);
    };
  } else {
    setInterval(() => { if (TrainingBot.active) TrainingBot.tick(); }, 200);
  }

  console.log("[TrainingBot] 🤖 Загружен с поддержкой авто-рестарта.");
})();