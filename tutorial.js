// tutorial.js
let tutorialLocked = false;

let tutorialSteps = []; // Изначально пустой массив
let tutorialDialogIndex = 0;

const tutorialDialog = [
  {
    text: "Приветствую тебя, кадет.\nТы прибыл на обучающую миссию мира GeoMetra.\nДобро пожаловать!",
    button: "Далее"
  },
  {
    text: "Твоя первая задача — построить склад рядом с базой.\nЭто необходимо для хранения ресурсов.",
    button: "Понятно"
  }
];

function showTutorialDialogText(text, buttonText = "Ок", onNext = null) {
  const existing = document.getElementById("tutorialDialog");
  if (existing) existing.remove();

  const dialog = document.createElement("div");
  dialog.id = "tutorialDialog";
  dialog.style.position = "fixed";
  dialog.style.top = "80px";
dialog.style.left = "20px";
dialog.style.transform = "none";

  dialog.style.background = "rgba(0,0,0,0.9)";
  dialog.style.color = "#0f0";
  dialog.style.padding = "20px";
  dialog.style.border = "2px solid #0f0";
  dialog.style.borderRadius = "10px";
  dialog.style.zIndex = "10000";
  dialog.style.width = "60%";
  dialog.style.maxWidth = "500px";
  dialog.style.textAlign = "center";
  dialog.style.fontFamily = "Orbitron, sans-serif";

  const message = document.createElement("p");
  message.innerText = text;
  message.style.marginBottom = "20px";

  const button = document.createElement("button");
  button.innerText = buttonText;
  button.style.padding = "10px 20px";
  button.style.background = "#0f0";
  button.style.color = "#000";
  button.style.fontWeight = "bold";
  button.style.border = "none";
  button.style.cursor = "pointer";
  button.onclick = () => {
    dialog.remove();
    if (onNext) onNext();
  };

  dialog.appendChild(message);
  dialog.appendChild(button);
  document.body.appendChild(dialog);
}


function startTutorial() {
  if (!gameState || !canvas || !camera || typeof worldWidth === "undefined") {
    alert("Ошибка инициализации!");
    return;
  }

  resetGameState();

  playerId = "player";
  opponentId = "ai";
  gameMode = "tutorial"; // <-- обязательно до скрытия UI!

  // Скрываем перки
  const perkSlots = document.getElementById("perkSlots");
  const perkMenu = document.getElementById("perkMenu");
  if (perkSlots) perkSlots.style.display = "none";
  if (perkMenu) perkMenu.style.display = "none";

  // === Расстановка баз и ресурсов ===
  const px = worldWidth / 2;
  const py = worldHeight / 2;

  playerBase = new Building("base", playerId, px, py);
  playerBase.active = true;
  gameState.buildings.push(playerBase);

  const r1 = new Resource("gold", px + 150, py, 1000, 1000);
  const r2 = new Resource("silicon", px - 150, py, 1000, 1000);
  gameState.resources.push(r1, r2);

  const enemy = new Unit("fighter", "ai", px + 300, py + 100);
  gameState.units.push(enemy);

  camera.offsetX = canvas.width / 2 - px * camera.scale;
  camera.offsetY = canvas.height / 2 - py * camera.scale;

  document.getElementById("controlsWrapper").style.display = "block";
  updateResourceUI();

  requestAnimationFrame(gameLoop);

  // === Вступительный диалог ===
  tutorialDialogIndex = 0;
  showTutorialDialogText(
    "Приветствую тебя, кадет.\nТы прибыл на обучающую миссию мира GeoMetra.\nДобро пожаловать!",
    "Далее",
    () => {
      showTutorialDialogText(
        "Для начала осмотрись.\nТы можешь приблизить или отдалить камеру колесом мыши или пальцами.",
        "Готово",
        () => {
          setTimeout(() => {
            showTutorialDialogText(
              "Твоя первая задача — построить склад рядом с базой.\nЭто необходимо для хранения ресурсов.",
              "Понятно",
              () => {
                setupInitialTasks();
              }
            );
          }, 6000);
        }
      );
    }
  );
	window.waveEnemies = [];
for (let i = 0; i < 5; i++) {
  const ex = playerBase.x + 800 + i * 50;
  const ey = playerBase.y + 300 + Math.random() * 100;

  const enemy = new Unit("fighter", "ai", ex, ey);
  enemy.attackRange = 100;
  enemy.reloadTime = 1.5;
  enemy.speed = 40;
  enemy.range = 400;
  enemy.isTutorialWave = true; // 👈 метка, если нужно

  window.waveEnemies.push(enemy);
  gameState.units.push(enemy); // добавляем в игру, но не активируем
}


}


let tutorialStepLocked = false;

function checkTutorialProgress() {
  if (tutorialSteps.length === 0 || tutorialStepLocked) return;

  const currentStep = tutorialSteps[0];
  if (currentStep.condition()) {
    tutorialStepLocked = true;

    currentStep.onComplete?.();

    tutorialSteps.shift(); // удаляем шаг
    setTimeout(() => {
      if (tutorialSteps[0]) {
        showTutorialDialogText(tutorialSteps[0].description, "Ок", () => {
          tutorialStepLocked = false;
        });
      } else {
        showTutorialDialogText("🎉 Обучение завершено!", "Ок", () => {
          tutorialStepLocked = false;
        });
      }
    }, 4000); // даём времени появиться диалогу
  }
}

// Очистка состояния
function resetGameState() {
  gameState.buildings = [];
  gameState.units = [];
  gameState.resources = [];
  gameState.bullets = [];
  gameState.particles = [];
  gameState.fragments = [];
  gameState.playerResources = { gold: 500, silicon: 500, plasma: 200 };
  updateResourceUI();
}

// Инициализация ресурсов для обучения
function setupInitialTasks() {
  tutorialSteps.push(
    {
      description: "Коснись базового корабля первого уровня и ты увидишь меню строительства!",
      condition: () => gameState.buildings.some(b => b.type === "warehouse" && b.owner === playerId),
      onComplete: () => {
        giveResources(WORKER_COST);
        showTutorialDialogText(
          "Вы установили маяк для вызова склада! Как только он активируется, найми 5 ресурсных ботов!"
        );
      }
    },
    {
      description: "Найми 5 ресурсных ботов!",
      condition: () =>
        gameState.units.filter(u => u.type === "worker" && u.owner === playerId).length >= 5,
      onComplete: () => {
        showTutorialDialogText("Замечательно! Боты начнут добывать ресурсы. Каждый приносит по 5 единиц автоматически!");
      }
    },
    {
      description: "Вызови корабль-мастерскую!",
      condition: () => gameState.buildings.some(b => b.type === "repairWorkshop" && b.owner === playerId),
      onComplete: () => {
        giveResources(REPAIRMAN_COST);
        showTutorialDialogText("Терпение! \nКаждый материнский корабль тратит разное количество времени для выхода из гиперпространства!");
      }
    },
    {
      description: "Найми 5  ботов ремонтников!",
      condition: () =>
        gameState.units.filter(u => u.type === "repairman" && u.owner === playerId).length >= 5,
      onComplete: () => {
        showTutorialDialogText("Теперь они будут ремонтировать все поврежденные объекты вокруг!");
      }
    },
    {
      description: "Вызови материнский корабль-файтер!",
      condition: () => gameState.buildings.some(b => b.type === "barracks" && b.owner === playerId),
      onComplete: () => {
        giveResources({ gold: 200, silicon: 100, plasma: 0 });
        showTutorialDialogText("Дождись когда Корабль выйдет из прыжка");
      }
    },
    {
      description: "Заполни очередь найма боевых юнитов файтер-01 кликнув на корабль. \nТы можешь ставить в очередь до 10 файтеров!",
      condition: () =>
        gameState.units.filter(u => u.type === "fighter" && u.owner === playerId).length >= 2,
      onComplete: () => {
		  
 
        const enemy1 = new Unit("fighter", "ai", playerBase.x + 250, playerBase.y + 80);
        const enemy2 = new Unit("fighter", "ai", playerBase.x + 270, playerBase.y + 100);
enemy1.isFirstWave = true;
          enemy2.isFirstWave = true;
        [enemy1, enemy2].forEach(enemy => {
          enemy.attackRange = 100;
          enemy.reloadTime = 1.5;
          enemy.speed = 40;
        });

        gameState.units.push(enemy1, enemy2);

        gameState.units
          .filter(u => u.owner === "ai" && u.type === "fighter")
          .forEach(enemy => {
            const target = gameState.buildings.find(
              b => b.owner === playerId && b.type !== "beacon" && b.health > 0
            );
            if (target) enemy.target = target;
            startFighterCycle(enemy);
          });

        showTutorialDialogText("Враги замечены! \nПострой турель для защиты!", "Есть!");
      }
    },
    {
      description: "Построй турель рядом с базой! \nНадо защищать важные обьекты!",
      condition: () => gameState.buildings.some(b => b.type === "turret" && b.owner === playerId),
      onComplete: () => {
        showTutorialDialogText("Отлично! \nТурель справится с угрозой.", "Наблюдать");
      }
    },
    {
      description: "Подождите, пока враг будет уничтожен",
      condition: () =>
  !gameState.units.some(u => u.owner === "ai" && u.type === "fighter" && u.isFirstWave),

      onComplete: () => {
        showTutorialDialogText("Хорошо! Ты отразил первую атаку в своей карьере! \nСтоит восполнить потеряные рабочие и ремонтные боты!\nИ помни, кадет: важно соблюдать баланс между обороной и нападением!", "Понятно");
      }
    },
    {
      description: "Дождись создания свого первго боевго звена кадет! \nА пока у тебя есть время попробовать отдать приказы уже созданым юнитам или обьеденить их в группы!",
      condition: () =>
        gameState.units.filter(u =>
          u.owner === playerId && ["fighter"].includes(u.type)
        ).length >= 9,
      onComplete: () => {
        // Внутри onComplete:
tutorialStepLocked = true;

showTutorialDialogText(
  "Ты можешь назначить группы юнитов!\nчерез панель управления на экране или сочетанием клавиш ctrl+1,2,3.\nТеперь ты управляешь полноценной боевой группой..." +
  "Группы позволяют быстро вызывать нужные боевые соединения для гибкого стратегического управления!",
  "Понятно",
  () => {
    // ⏳ Только через 6 секунд продолжаем обучение
    setTimeout(() => {
      tutorialStepLocked = false;
      checkTutorialProgress();
    }, 10000);
  }
);
      }
    },
    {
      description: "Построй маяк",
      condition: () => gameState.buildings.some(b => b.type === "beacon" && b.owner === playerId),
      onComplete: () => {
  showTutorialDialogText(
    "Маяк активирован! Он расширяет твою зону строительства сильнее, чем другие корабли.\nИспользуй это для контроля карты!",
    "Ок"
  );

  tutorialStepLocked = true;

 
   const perkSlots = document.getElementById("perkSlots");
if (perkSlots) perkSlots.style.display = "flex";

showTutorialDialogText(
  "Внимание, Кадет! Найди и уничтожь все учебные цели на карте!\nИспользуй перки в правом верхнем углу (клавиши 5,6,7).\nПопробуй назначать группы (Ctrl+1,2,3) и менять формации (C, V, B)!",
  "Готов",
  () => {
    launchEnemyWave(); // юниты появляются

    // ⏳ Ждём 6 секунд перед продолжением обучения
    setTimeout(() => {
      tutorialStepLocked = false;
      checkTutorialProgress();
    }, 10000);
  }
);

  
}

    },
     {
    description: "Удачи кадет!!!",
    condition: () => !gameState.units.some(u => u.owner === "ai"),
    onComplete: () => {
      showTutorialDialogText(
        "Поздравляем, кадет! Ты прошёл обучение и получил звание — **РЯДОВОЙ** GeoMetra!",
        "Завершить",
        () => {
          location.reload(); // ⬅️ Переход в главное меню
        }
      );
    }
  }
);

// Показываем первый шаг обучения
showTutorialDialogText(tutorialSteps[0].description);
}


function launchEnemyWave() {
  if (!window.waveEnemies) return;

  const base = gameState.buildings.find(b => b.type === "base" && b.owner === "player");
  if (!base) return;

  const targetX = base.x;
  const targetY = base.y;

  window.waveEnemies.forEach((enemy, index) => {
    enemy.commandQueue = [];

    const angleOffset = (index % 2 === 0 ? -1 : 1) * (Math.PI / 6); // ±30°
    const baseAngle = Math.atan2(targetY - enemy.y, targetX - enemy.x);
    const flankAngle = baseAngle + angleOffset;

    const flankX = targetX + Math.cos(flankAngle) * 100;
    const flankY = targetY + Math.sin(flankAngle) * 100;

    enemy.commandQueue.push({ type: "move", x: flankX, y: flankY });
    enemy.commandQueue.push({ type: "attack", target: base });

    processCommandQueue(enemy); // 💥 обязательно!
  });
}








// Простая функция выдачи ресурсов
function giveResources(cost) {
  gameState.playerResources.gold += cost.gold;
  gameState.playerResources.silicon += cost.silicon;
  gameState.playerResources.plasma += cost.plasma;
  updateResourceUI();
}

// Интерфейс обучения
function showTutorialUI() {
  const existingPanel = document.getElementById("tutorialPanel");
  if (existingPanel) existingPanel.remove();

  const tutorialPanel = document.createElement("div");
  tutorialPanel.id = "tutorialPanel";
  tutorialPanel.style.position = "fixed";
  tutorialPanel.style.top = "10px";
  tutorialPanel.style.left = "50%";
  tutorialPanel.style.transform = "translateX(-50%)";
  tutorialPanel.style.padding = "10px";
  tutorialPanel.style.backgroundColor = "rgba(0,0,0,0.8)";
  tutorialPanel.style.color = "white";
  tutorialPanel.style.zIndex = "9999";
  tutorialPanel.innerText = tutorialSteps[0].description;
  document.body.appendChild(tutorialPanel);
}

// Сообщения пользователю
function showMessage(msg) {
  const messageEl = document.createElement("div");
  messageEl.innerText = msg;
  messageEl.style.position = "fixed";
  messageEl.style.bottom = "10px";
  messageEl.style.left = "50%";
  messageEl.style.transform = "translateX(-50%)";
  messageEl.style.padding = "8px";
  messageEl.style.background = "rgba(0,0,0,0.7)";
  messageEl.style.color = "#fff";
  messageEl.style.borderRadius = "5px";
  messageEl.style.zIndex = "9999";
  document.body.appendChild(messageEl);

  setTimeout(() => messageEl.remove(), 3000);
}
// Скрываем экран загрузки
document.getElementById("loadingScreen").style.display = "none";

// Показываем канвас (если вдруг скрыт) и интерфейс
canvas.style.display = "block";
document.getElementById("controlsWrapper").style.display = "block";
setTimeout(() => {
  document.getElementById("controlsWrapper").style.opacity = 1;
}, 100);

// Подключаем обработчик для кнопки обучения
//document.getElementById("tutorialButton").addEventListener("click", () => {
//  console.log("📘 Кнопка обучения нажата!");
//  document.getElementById("loadingScreen").style.display = "none";
 // startTutorial();
//});

function waitForWorkers(count, callback) {
  const interval = setInterval(() => {
    const workers = gameState.units.filter(u => u.owner === playerId && u.type === "worker");
    if (workers.length >= count) {
      clearInterval(interval);
      callback();
    }
  }, 500); // Проверяем каждые 0.5 сек
}


