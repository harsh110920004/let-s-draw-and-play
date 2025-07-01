const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);

app.use(express.static(__dirname));
const DEFAULT_WORDS = [
  // Animals
  "cat", "dog", "lion", "tiger", "elephant", "giraffe", "zebra", "fish", "shark", "whale",
  "dolphin", "penguin", "kangaroo", "monkey", "rabbit", "snake", "bat", "camel", "cow", "horse",

  // Food
  "pizza", "burger", "ice cream", "hot dog", "cake", "apple", "banana", "carrot", "sandwich",
  "cheese", "bread", "donut", "egg", "fries", "grapes", "lemon", "noodles", "orange", "peach", "popcorn",

  // Objects
  "bottle", "cup", "glass", "pen", "pencil", "phone", "laptop", "computer", "keyboard", "mouse",
  "chair", "table", "mirror", "clock", "lamp", "book", "scissors", "backpack", "umbrella", "key",

  // Nature
  "sun", "moon", "star", "cloud", "rain", "snowflake", "tree", "flower", "leaf", "mountain",
  "river", "ocean", "volcano", "fire", "ice", "lightning", "tornado", "rock", "desert", "cave",

  // Vehicles
  "car", "bus", "truck", "train", "airplane", "boat", "ship", "bicycle", "motorcycle", "helicopter",
  "rocket", "submarine", "scooter", "skateboard", "ambulance", "fire truck", "tractor", "jeep", "van", "taxi",

  // Clothes
  "shirt", "pants", "shorts", "jacket", "hat", "cap", "dress", "skirt", "shoes", "socks",
  "gloves", "scarf", "belt", "tie", "boots", "glasses", "watch", "sunglasses", "hoodie", "suit",

  // Sports
  "football", "basketball", "tennis", "cricket", "golf", "baseball", "hockey", "badminton", "volleyball", "boxing",
  "swimming", "cycling", "skiing", "surfing", "karate", "chess", "skating", "bowling", "archery", "table tennis",

  // Fantasy & Fiction
  "dragon", "unicorn", "fairy", "wizard", "witch", "ghost", "zombie", "vampire", "mermaid", "alien",
  "robot", "superhero", "monster", "dinosaur", "knight", "sword", "magic wand", "castle", "treasure", "pirate",

  // Places & Structures
  "house", "building", "school", "hospital", "church", "bridge", "tower", "pyramid", "tent", "castle",
  "barn", "igloo", "mosque", "lighthouse", "windmill", "fountain", "fence", "road", "airport", "train station",

  // Tools
  "hammer", "screwdriver", "wrench", "saw", "drill", "shovel", "rake", "broom", "mop", "axe",
  "ladder", "toolbox", "needle", "scissors", "tape", "glue", "paintbrush", "bucket", "plunger", "rope",

  // Technology & Media
  "camera", "TV", "radio", "microphone", "speaker", "headphones", "remote", "battery", "charger", "drone",
  "tablet", "monitor", "printer", "projector", "game console", "joystick", "router", "satellite", "VR headset", "clock",

  // Miscellaneous
  "balloon", "gift", "flag", "medal", "trophy", "puzzle", "map", "ticket", "calendar", "envelope",
  "mailbox", "paint", "soap", "toothbrush", "toilet", "sink", "bed", "fan", "curtain", "carpet"
];

const MAX_ROUNDS = 5;

let rooms = {}; // roomCode -> { users, round, currentTurn, word, words, timer, adminId }

io.on("connection", (socket) => {
  let userRoom = "";
  let userName = "";

  socket.on("joinRoom", ({ name, room, customWords }) => {
    userRoom = room;
    userName = name;

    if (!rooms[room]) {
      rooms[room] = {
        users: [],
        round: 1,
        currentTurn: 0,
        words: customWords.length > 0 ? customWords : DEFAULT_WORDS,
        adminId: socket.id
      };
    }

    const state = rooms[room];
    state.users.push({ id: socket.id, name, score: 0 });
    socket.join(room);

    io.to(room).emit("message", `${name} joined room ${room}`);
    updateScores(room);

    if (socket.id === state.adminId) {
      io.to(socket.id).emit("isAdmin");
    }

    if (state.users.length === 1) {
      startTurn(room);
    }
  });

  socket.on("draw", ({ room, ...data }) => {
    const drawer = getCurrentDrawer(room);
    if (drawer && socket.id === drawer.id) {
      socket.to(room).emit("draw", data);
    }
  });

  socket.on("guess", ({ room, guess }) => {
    const state = rooms[room];
    if (!state) return;

    const drawer = getCurrentDrawer(room);
    const guesser = state.users.find(u => u.id === socket.id);

    if (!guesser || !drawer || !drawer.word) return;
    if (socket.id === drawer.id) {
      io.to(socket.id).emit("message", "You cannot guess while drawing.");
      return;
    }

    if (guess.toLowerCase() === drawer.word.toLowerCase()) {
      guesser.score += 10;
      io.to(room).emit("message", `${guesser.name} guessed the word!`);
      updateScores(room);
      clearInterval(state.timer);
      state.currentTurn++;
      setTimeout(() => nextTurnOrEnd(room), 2000);
    } else {
      io.to(room).emit("message", `${guesser.name}: ${guess}`);
    }
  });

  socket.on("wordSelected", ({ room, word }) => {
    const state = rooms[room];
    if (!state) return;

    const drawer = getCurrentDrawer(room);
    if (!drawer) return;

    drawer.word = word;
    state.word = word;

    io.to(drawer.id).emit("turn", { drawer: drawer.name, wordHint: word, isYourTurn: true });

    state.users.forEach(u => {
      if (u.id !== drawer.id) {
        io.to(u.id).emit("turn", { drawer: drawer.name, wordHint: "_ ".repeat(word.length), isYourTurn: false });
      }
    });

    startTimer(room, word);
  });

  socket.on("pauseGame", (room) => {
    const state = rooms[room];
    if (socket.id === state?.adminId && state?.timer) {
      clearInterval(state.timer);
      io.to(room).emit("message", "⏸ Game paused by admin.");
    }
  });

  socket.on("resumeGame", (room) => {
    const state = rooms[room];
    if (!state || socket.id !== state.adminId) return;
    if (!state.word) return;
    io.to(room).emit("message", "▶ Game resumed by admin.");
    startTimer(room, state.word, state.timeLeft || 45);
  });

  socket.on("skipTurn", (room) => {
    const state = rooms[room];
    if (socket.id === state?.adminId) {
      clearInterval(state.timer);
      state.currentTurn++;
      io.to(room).emit("message", "⏭ Turn skipped by admin.");
      nextTurnOrEnd(room);
    }
  });

  socket.on("resetGame", (room) => {
    const state = rooms[room];
    if (socket.id === state?.adminId) {
      clearInterval(state.timer);
      state.currentTurn = 0;
      state.round = 1;
      state.users.forEach(u => u.score = 0);
      io.to(room).emit("message", "🔄 Game reset by admin.");
      updateScores(room);
      startTurn(room);
    }
  });

  socket.on("clearCanvas", (room) => {
    const state = rooms[room];
    const drawer = getCurrentDrawer(room);
    if (drawer && drawer.id === socket.id) {
      io.to(room).emit("clearCanvas");
    }
  });

  socket.on("chatMessage", ({ room, msg }) => {
    const state = rooms[room];
    const sender = state?.users.find(u => u.id === socket.id);
    if (sender) {
      io.to(room).emit("chatMessage", { name: sender.name, msg });
    }
  });

  socket.on("disconnect", () => {
    const state = rooms[userRoom];
    if (!state) return;

    state.users = state.users.filter(u => u.id !== socket.id);
    io.to(userRoom).emit("message", `${userName} left the room.`);
    updateScores(userRoom);

    if (state.users.length === 0) {
      delete rooms[userRoom];
    } else if (socket.id === state.adminId) {
      state.adminId = state.users[0].id;
      io.to(state.adminId).emit("isAdmin");
      io.to(userRoom).emit("message", `⚠️ Admin left. New admin: ${state.users[0].name}`);
    }
  });

  function getCurrentDrawer(room) {
    const state = rooms[room];
    if (!state) return null;
    return state.users[state.currentTurn % state.users.length];
  }

  function updateScores(room) {
    const state = rooms[room];
    if (!state) return;
    io.to(room).emit("scoreboard", state.users.map(u => ({ name: u.name, score: u.score })));
  }

  function getRandomWords(wordList, count) {
    const result = [];
    while (result.length < count && wordList.length >= count) {
      const word = wordList[Math.floor(Math.random() * wordList.length)];
      if (!result.includes(word)) result.push(word);
    }
    return result;
  }

  function startTurn(room) {
    const state = rooms[room];
    if (!state) return;

    const drawer = getCurrentDrawer(room);
    delete drawer.word;
    state.word = null;

    const choices = getRandomWords(state.words, 3);
    const currentRound = Math.floor(state.currentTurn / state.users.length) + 1;
    io.to(room).emit("roundUpdate", currentRound);
    io.to(drawer.id).emit("chooseWord", choices);
  }

  function nextTurnOrEnd(room) {
    const state = rooms[room];
    if (!state) return;

    if (state.currentTurn >= state.users.length * MAX_ROUNDS) {
      const winner = state.users.sort((a, b) => b.score - a.score)[0];
      io.to(room).emit("gameOver", winner);
      delete rooms[room];
    } else {
      startTurn(room);
    }
  }

  function startTimer(room, word, startTime = 45) {
    const state = rooms[room];
    if (!state) return;

    let timeLeft = startTime;
    state.word = word;
    state.timeLeft = timeLeft;
    io.to(room).emit("timer", timeLeft);

    state.timer = setInterval(() => {
      timeLeft--;
      state.timeLeft = timeLeft;
      io.to(room).emit("timer", timeLeft);
      if (timeLeft <= 0) {
        clearInterval(state.timer);
        io.to(room).emit("message", `⏰ Time's up! The word was: ${word}`);
        state.currentTurn++;
        nextTurnOrEnd(room);
      }
    }, 1000);
  }
});

http.listen(3000, () => console.log("🎨 Server running at http://localhost:3000"));
