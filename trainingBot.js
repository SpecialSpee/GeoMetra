// ============================================================
// trainingBot.js — Сверхбыстрый и агрессивный тренировочный бот
// ============================================================
(function () {
  "use strict";

  if (window.TrainingBot) {
    return;
  }
	
	  // 🔥 PBT: Профили противников для эволюционного обучения
  window.OPPONENT_PROFILES = [
    { name: "Rush", aggression: 0.9, eco: 0.3, expand: 0.1 },
    { name: "Turtle", aggression: 0.2, eco: 0.9, expand: 0.4 },
    { name: "Balanced", aggression: 0.5, eco: 0.6, expand: 0.5 },
    { name: "Macro", aggression: 0.4, eco: 0.8, expand: 0.8 }
  ];

  const TrainingBot = {
    active: false,
    lastActionTime: 0,
    phase: 0,
    
    // 🔥 УСКОРЕНИЕ: Фазы сокращены в 2-3 раза
    phases: [
      { name: "Economy Rush", duration: 160, action: "buildEconomy" },       
      { name: "Army & Defense", duration: 160, action: "buildArmy" },   
      { name: "Tech Tier 2", duration: 130, action: "techUp2" },        
      { name: "Mid Game Army", duration: 160, action: "buildMidArmy" }, 
      { name: "Tech Tier 3", duration: 130, action: "techUp3" },        
      { name: "Late Game Waves", duration: 9999, action: "largeAttacks" } 
    ],

    init: function () {
      this.active = true;
      this.phase = 0;
      this.startTime = performance.now();
      this.lastActionTime = performance.now();
      // 🔥 PBT: Случайный выбор профиля при каждом запуске
      this.profile = window.OPPONENT_PROFILES[Math.floor(Math.random() * window.OPPONENT_PROFILES.length)];
      console.log(`[TrainingBot] 🎭 Загружен профиль: ${this.profile.name} (Agg: ${this.profile.aggression}, Eco: ${this.profile.eco})`);
    },

    stop: function () {
      this.active = false;
    },

    tick: function () {
      if (!this.active || !gameStarted || gameState.gameEnded || gameMode !== "gnn") return;
      
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

      // 🔥 УСКОРЕНИЕ: Действуем каждые 200 мс (вместо 1500 мс)
      if (now - this.lastActionTime < 200) return; 
      this.lastActionTime = now;

      const action = this.phases[this.phase].action;
      this[action]();
    },
	  
    buildEconomy: function () {
      const warehouses = gameState.buildings.filter(b => b.owner === "player" && b.type === "warehouse").length;
      const workshops = gameState.buildings.filter(b => b.owner === "player" && b.type === "repairWorkshop").length;
      const workers = gameState.units.filter(u => u.owner === "player" && u.type === "worker").length;

      // 🔥 УСКОРЕНИЕ: Независимые IF вместо ELSE IF. Бот делает всё сразу, если есть ресурсы.
      if (warehouses < 4 && typeof canSpendResources === "function" && canSpendResources(WAREHOUSE_COST, "player")) {
        const pos = this.findBuildPos("warehouse");
        if (pos) { placeBuilding(pos.x, pos.y, "warehouse", "player"); }
      } 
      
      if (workshops === 0 && typeof canSpendResources === "function" && canSpendResources(REPAIR_WORKSHOP_COST, "player")) {
        const pos = this.findBuildPos("repairWorkshop");
        if (pos) { placeBuilding(pos.x, pos.y, "repairWorkshop", "player"); }
      } 
      
       // 🔥 PBT: Адаптивный найм рабочих в зависимости от профиля
      const targetWorkers = Math.floor(15 * this.profile.eco);
      if (workers < targetWorkers) {
        this.hireWorker();
      }
    },

       buildArmy: function () {
      const barracks = gameState.buildings.filter(b => b.owner === "player" && b.type === "barracks").length;
      // Проверяем также очередь строительства, чтобы не спамить постройкой, если она уже в пути
      const barracksInQueue = (window.buildQueue || []).filter(q => q.type === "barracks").length;
      
      const beacons = gameState.buildings.filter(b => b.owner === "player" && b.type === "beacon").length;
      const turrets = gameState.buildings.filter(b => b.owner === "player" && b.type?.startsWith("turret")).length;
      const fighters = gameState.units.filter(u => u.owner === "player" && u.type === "fighter").length;

      const maxTurrets = beacons * 3;

      // 🔥 ДИАГНОСТИКА: Почему не строим казарму?
      if (barracks === 0 && barracksInQueue === 0) {
        //console.log("[Bot Debug] Пытаюсь построить казарму...");
        
        if (typeof canSpendResources !== "function") {
          console.warn("[Bot Debug] ❌ ОШИБКА: Функция canSpendResources не найдена!");
        } else if (!canSpendResources(BARRACKS_COST, "player")) {
          //console.warn(`[Bot Debug] ❌ ОШИБКА: Не хватает ресурсов! Нужно: ${JSON.stringify(BARRACKS_COST)}`);
        } else {
          const pos = this.findBuildPos("barracks");
          if (!pos) {
            console.warn("[Bot Debug] ❌ ОШИБКА: findBuildPos вернул null (не нашел место)!");
          } else {
            //console.log(`[Bot Debug] ✅ Место найдено (${pos.x}, ${pos.y}). Пробую placeBuilding...`);
            if (typeof placeBuilding === "function") {
              placeBuilding(pos.x, pos.y, "barracks", "player");
              //console.log("[Bot Debug] 🏗️ Команда на постройку казармы отправлена!");
            } else if (typeof window.scheduleAIBuilding === "function") {
              window.scheduleAIBuilding("barracks", pos.x, pos.y, 0);
              //console.log("[Bot Debug] 🏗️ Команда на постройку казармы отправлена (через schedule)!");
            } else {
              console.warn("[Bot Debug] ❌ ОШИБКА: Функция placeBuilding или scheduleAIBuilding не найдена!");
            }
          }
        }
      }
      
      // Остальная логика для маяков, турелей и файтеров
      if (beacons === 0 && typeof canSpendResources === "function" && canSpendResources(BEACON_COST, "player")) {
        const pos = this.findBuildPos("beacon");
        if (pos) { 
          typeof placeBuilding === "function" ? placeBuilding(pos.x, pos.y, "beacon", "player") : window.scheduleAIBuilding("beacon", pos.x, pos.y, 0); 
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
      
      // Сразу начинаем нанимать штурмовиков, как только появилась Казарма 2
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
        if (pos) { placeBuilding(pos.x, pos.y, "base3", "player"); }
      } 
      
      if (hasBase3 && !hasBarracks3 && typeof canSpendResources === "function" && canSpendResources(BARRACKS3_COST, "player")) {
        const pos = this.findBuildPos("barracks3");
        if (pos) { placeBuilding(pos.x, pos.y, "barracks3", "player"); }
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

      // 🔥 PBT: Адаптивный размер атаки
      const attackThreshold = Math.max(4, Math.floor(12 * (1.2 - this.profile.aggression)));
      if (army.length >= attackThreshold) {
        this.sendAttackGroup(army.slice(0, Math.floor(10 * this.profile.aggression) + 2));
      }
    },

    // --- Функции жадного найма (нанимают пачками) ---
    
    hireWorker: function () {
      // Пытаемся нанять до 3 рабочих за один тик
      for (let i = 0; i < 3; i++) {
        const warehouse = gameState.buildings.find(b => b.owner === "player" && b.type === "warehouse" && b.active && (b.workers || 0) < (b.maxDeliveryWorkers || 5));
        if (warehouse && typeof canSpendResources === "function" && canSpendResources(WORKER_COST, "player") && typeof hireWorkerForPlayer === "function") {
          hireWorkerForPlayer(warehouse);
        } else {
          break; // Нет ресурсов или места, прерываем цикл
        }
      }
    },

    hireFighter: function () {
      for (let i = 0; i < 3; i++) {
        const barracks = gameState.buildings.find(b => b.owner === "player" && b.type === "barracks" && b.active);
        if (barracks && typeof canSpendResources === "function" && canSpendResources(FIGHTER_COST, "player") && typeof hireFighterForPlayer === "function") {
          hireFighterForPlayer(barracks);
        } else {
          break;
        }
      }
    },

    hireAssault: function () {
      for (let i = 0; i < 3; i++) {
        const barracks2 = gameState.buildings.find(b => b.owner === "player" && b.type === "barracks2" && b.active);
        if (barracks2 && typeof canSpendResources === "function" && canSpendResources(ASSAULT_COST, "player") && typeof hireAssaultForPlayer === "function") {
          hireAssaultForPlayer(barracks2);
        } else {
          break;
        }
      }
    },

    hireElite: function () {
      for (let i = 0; i < 2; i++) { // Элита дороже, нанимаем по 2 за раз
        const barracks3 = gameState.buildings.find(b => b.owner === "player" && b.type === "barracks3" && b.active);
        if (barracks3 && typeof canSpendResources === "function" && canSpendResources(ELITE_COST, "player") && typeof hireEliteForPlayer === "function") {
          hireEliteForPlayer(barracks3);
        } else {
          break;
        }
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

  const origGameLoop = window.gameLoop;
  if (typeof origGameLoop === "function") {
    window.gameLoop = function (timestamp) {
      if (TrainingBot.active) TrainingBot.tick();
      origGameLoop(timestamp);
    };
  } else {
    setInterval(() => { if (TrainingBot.active) TrainingBot.tick(); }, 200);
  }

  console.log("[TrainingBot] 🤖 Загружен. Введи startTrainingBot() в консоли для запуска.");
})();