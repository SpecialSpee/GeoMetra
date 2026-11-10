// ============================================================
// trainingBot.js — Надежный и сильный тренировочный бот (Строгий Tech Tree)
// ============================================================
(function () {
  "use strict";

  if (window.TrainingBot) {
    //console.warn("[TrainingBot] уже загружен");
    return;
  }

  const TrainingBot = {
    active: false,
    lastActionTime: 0,
    phase: 0,
    
    phases: [
      { name: "Economy", duration: 100, action: "buildEconomy" },       
      { name: "Army & Defense", duration: 100, action: "buildArmy" },   
      { name: "Tech Tier 2", duration: 60, action: "techUp2" },        
      { name: "Mid Game Army", duration: 100, action: "buildMidArmy" }, 
      { name: "Tech Tier 3", duration: 60, action: "techUp3" },        
      { name: "Late Game Waves", duration: 9999, action: "largeAttacks" } 
    ],

    init: function () {
      this.active = true;
      this.phase = 0;
      this.startTime = performance.now();
      this.lastActionTime = performance.now();
      //console.log("[TrainingBot] ✅ Активирован! Режим: Надежный и сильный соперник.");
    },

    stop: function () {
      this.active = false;
      //console.log("[TrainingBot] ⏹ Бот деактивирован.");
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

      if (now - this.lastActionTime < 1500) return; 
      this.lastActionTime = now;

      const action = this.phases[this.phase].action;
      //console.log(`[Bot] 🕒 Фаза: ${this.phases[this.phase].name} (Время: ${gameTimeSec.toFixed(0)}с)`);
      this[action]();
    },
	  
    buildEconomy: function () {
      const warehouses = gameState.buildings.filter(b => b.owner === "player" && b.type === "warehouse").length;
      const workshops = gameState.buildings.filter(b => b.owner === "player" && b.type === "repairWorkshop").length;
      const workers = gameState.units.filter(u => u.owner === "player" && u.type === "worker").length;

      if (warehouses < 4 && canSpendResources(WAREHOUSE_COST, "player")) {
        const pos = this.findBuildPos("warehouse");
        if (pos) { placeBuilding(pos.x, pos.y, "warehouse", "player"); }
      } else if (workshops === 0 && canSpendResources(REPAIR_WORKSHOP_COST, "player")) {
        const pos = this.findBuildPos("repairWorkshop");
        if (pos) { placeBuilding(pos.x, pos.y, "repairWorkshop", "player"); }
      } else if (workers < 12) {
        this.hireWorker();
      }
    },

    buildArmy: function () {
      const barracks = gameState.buildings.filter(b => b.owner === "player" && b.type === "barracks").length;
      const beacons = gameState.buildings.filter(b => b.owner === "player" && b.type === "beacon").length;
      const turrets = gameState.buildings.filter(b => b.owner === "player" && b.type?.startsWith("turret")).length;
      const fighters = gameState.units.filter(u => u.owner === "player" && u.type === "fighter").length;

      // 🔥 ПРАВИЛО: 1 маяк = 3 турели
      const maxTurrets = beacons * 3;

      // 1. Сначала Казарма
      if (barracks === 0 && canSpendResources(BARRACKS_COST, "player")) {
        const pos = this.findBuildPos("barracks");
        if (pos) { placeBuilding(pos.x, pos.y, "barracks", "player"); }
      } 
      // 2. Потом первый Маяк
      else if (beacons === 0 && canSpendResources(BEACON_COST, "player")) {
        const pos = this.findBuildPos("beacon");
        if (pos) { placeBuilding(pos.x, pos.y, "beacon", "player"); }
      } 
      // 3. Турели (строго в рамках лимита маяков)
      else if (turrets < maxTurrets && turrets < 3 && canSpendResources(TURRET_COST, "player")) {
        const pos = this.findBuildPos("turret");
        if (pos) { placeBuilding(pos.x, pos.y, "turret", "player"); }
      } 
      // 4. Нанимаем армию
      else if (fighters < 10) {
        this.hireFighter();
      }
    },
												 
	techUp2: function () {
	  const hasBeacon = gameState.buildings.some(b => b.owner === "player" && b.type === "beacon");
	  const hasBase2 = gameState.buildings.some(b => b.owner === "player" && b.type === "base2");
	  const hasBarracks2 = gameState.buildings.some(b => b.owner === "player" && b.type === "barracks2");

	  // 1. Сначала Маяк
	  if (!hasBeacon && canSpendResources(BEACON_COST, "player")) {
		const pos = this.findBuildPos("beacon");
		if (pos) { placeBuilding(pos.x, pos.y, "beacon", "player"); }
	  } 
	  // 2. Потом База 2
	  else if (hasBeacon && !hasBase2 && canSpendResources(BASE2_COST, "player")) {
		const pos = this.findBuildPos("base2");
		if (pos) { placeBuilding(pos.x, pos.y, "base2", "player"); }
	  } 
	  // 3. 🔥 И ТОЛЬКО ПОТОМ Казарма 2 (важно!)
	  else if (hasBase2 && !hasBarracks2 && canSpendResources(BARRACKS2_COST, "player")) {
		const pos = this.findBuildPos("barracks2");
		if (pos) { placeBuilding(pos.x, pos.y, "barracks2", "player"); }
	  }
	},

    buildMidArmy: function () {
      const beacons = gameState.buildings.filter(b => b.owner === "player" && b.type === "beacon").length;
      const turrets = gameState.buildings.filter(b => b.owner === "player" && b.type?.startsWith("turret")).length;
      const assaults = gameState.units.filter(u => u.owner === "player" && u.type === "assault").length;
      const hasBarracks2 = gameState.buildings.some(b => b.owner === "player" && b.type === "barracks2");

      // 🔥 ПРАВИЛО: 1 маяк = 3 турели. Чтобы иметь 6 турелей, нужно 2 маяка.
      const maxTurrets = beacons * 3;

      // 1. Строим турель, только если не превышен лимит текущих маяков
      if (turrets < maxTurrets && turrets < 6 && canSpendResources(TURRET_COST, "player")) {
        const pos = this.findBuildPos("turret");
        if (pos) { placeBuilding(pos.x, pos.y, "turret", "player"); }
      } 
      // 2. 🔥 КЛЮЧЕВОЕ ИСПРАВЛЕНИЕ: Если лимит достигнут (например, 3 турели при 1 маяке), 
      // а мы хотим больше (до 6), сначала строим ВТОРОЙ маяк!
      else if (turrets >= maxTurrets && turrets < 6 && beacons < 2 && canSpendResources(BEACON_COST, "player")) {
        const pos = this.findBuildPos("beacon");
        if (pos) { placeBuilding(pos.x, pos.y, "beacon", "player"); }
      }
      // 3. Нанимаем штурмовиков (только если есть Казарма 2)
      else if (hasBarracks2 && assaults < 10) {
        this.hireAssault();
      }
    },

		techUp3: function () {
		  const hasBase2 = gameState.buildings.some(b => b.owner === "player" && b.type === "base2");
		  const hasBarracks2 = gameState.buildings.some(b => b.owner === "player" && b.type === "barracks2");
		  const hasBase3 = gameState.buildings.some(b => b.owner === "player" && b.type === "base3");
		  const hasBarracks3 = gameState.buildings.some(b => b.owner === "player" && b.type === "barracks3");

		  // 🔥 ИСПРАВЛЕНИЕ: База 3 требует НЕ ТОЛЬКО Базу 2, но и Казарму 2!
		  if (hasBase2 && hasBarracks2 && !hasBase3 && canSpendResources(BASE3_COST, "player")) {
			const pos = this.findBuildPos("base3");
			if (pos) { placeBuilding(pos.x, pos.y, "base3", "player"); }
		  } 
		  else if (hasBase3 && !hasBarracks3 && canSpendResources(BARRACKS3_COST, "player")) {
			const pos = this.findBuildPos("barracks3");
			if (pos) { placeBuilding(pos.x, pos.y, "barracks3", "player"); }
		  }
		},

    largeAttacks: function () {
      const army = gameState.units.filter(u => u.owner === "player" && ["fighter", "assault", "elite"].includes(u.type) && u.health > 0 && (!u.commandQueue || u.commandQueue.length === 0));
      const elites = gameState.units.filter(u => u.owner === "player" && u.type === "elite").length;
      const hasBarracks3 = gameState.buildings.some(b => b.owner === "player" && b.type === "barracks3");

      if (hasBarracks3 && elites < 5) {
        this.hireElite();
        return;
      }

      if (army.length >= 15) {
        this.sendAttackGroup(army.slice(0, 20));
      } else {
        if (Math.random() < 0.5) this.hireFighter();
        else this.hireAssault();
      }
    },

    // --- Функции найма ---
    hireWorker: function () {
      const warehouse = gameState.buildings.find(b => b.owner === "player" && b.type === "warehouse" && b.active && (b.workers || 0) < (b.maxDeliveryWorkers || 5));
      if (warehouse && typeof hireWorkerForPlayer === "function") {
        hireWorkerForPlayer(warehouse);
      }
    },

    hireFighter: function () {
      const barracks = gameState.buildings.find(b => b.owner === "player" && b.type === "barracks" && b.active);
      if (barracks && typeof hireFighterForPlayer === "function") {
        hireFighterForPlayer(barracks);
      }
    },

    hireAssault: function () {
      const barracks2 = gameState.buildings.find(b => b.owner === "player" && b.type === "barracks2" && b.active);
      if (barracks2 && typeof hireAssaultForPlayer === "function") {
        hireAssaultForPlayer(barracks2);
      }
    },

    hireElite: function () {
      const barracks3 = gameState.buildings.find(b => b.owner === "player" && b.type === "barracks3" && b.active);
      if (barracks3 && typeof hireEliteForPlayer === "function") {
        hireEliteForPlayer(barracks3);
      }
    },

    sendAttackGroup: function (attackers) {
      const target = aiBase;
      attackers.forEach(u => {
        u.commandQueue = [{ type: "move", x: target.x, y: target.y }, { type: "attack", target: target }];
        if (typeof processCommandQueue === "function") processCommandQueue(u);
      });
      //console.log(`[TrainingBot] ⚔️ ОГРОМНАЯ ВОЛНА АТАКИ! Отправлено ${attackers.length} юнитов!`);
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
    setInterval(() => { if (TrainingBot.active) TrainingBot.tick(); }, 1500);
  }

  //console.log("[TrainingBot] 🤖 Загружен. Введи startTrainingBot() в консоли для запуска.");
})();