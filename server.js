const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });
app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};
const socketToRoom = {};
const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const SUITS = ['♠','♥','♦','♣'];

function makeDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push({ rank: r, suit: s });
  return shuffle(d);
}
function shuffle(a) {
  const b = [...a];
  for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random()*(i+1)); [b[i],b[j]]=[b[j],b[i]]; }
  return b;
}

function createRoom(roomId, hostId, mode) {
  return { id:roomId, hostId, mode:mode||'normal', status:'lobby', players:[],
    deck:[], centerCard:null, submissions:{}, submittedOrder:[],
    phase:'idle', turnTimer:null, chatLog:[], round:0, streamVotes:{} };
}

function broadcast(roomId, ev, data) { io.to(roomId).emit(ev, data); }

function publicState(room, forId) {
  return {
    roomId:room.id, mode:room.mode, status:room.status, phase:room.phase, round:room.round,
    centerCard:room.centerCard,
    submittedIds:Object.keys(room.submissions),
    submittedOrder:room.submittedOrder,
    players: room.players.map(p => ({
      id:p.id, name:p.name, avatar:p.avatar, hp:p.hp,
      handCount:p.hand?p.hand.length:0, isOut:!!p.isOut, isHost:p.id===room.hostId,
      submitted:!!room.submissions[p.id]
    })),
    myHand: forId ? (room.players.find(p=>p.id===forId)?.hand||[]) : [],
    chatLog: room.chatLog.slice(-40)
  };
}

function broadcastState(room) {
  room.players.forEach(p => {
    const s = io.sockets.sockets.get(p.socketId);
    if (s) s.emit('state', publicState(room, p.id));
  });
  io.to(room.id+'_spec').emit('state', publicState(room, null));
}

function addChat(room, msg) { room.chatLog.push({...msg, ts:Date.now()}); }
function clearTimer(room) { if(room.turnTimer){clearTimeout(room.turnTimer);room.turnTimer=null;} }

function checkWinner(room) {
  const alive = room.players.filter(p=>!p.isOut);
  if (alive.length===1) {
    room.status='finished'; room.phase='idle'; clearTimer(room);
    broadcast(room.id,'game_over',{winner:alive[0]});
    return true;
  }
  return false;
}

function startRound(room) {
  if (checkWinner(room)) return;
  if (room.deck.length < 5) room.deck = makeDeck();
  room.centerCard = room.deck.pop();
  room.submissions = {};
  room.submittedOrder = [];
  room.phase = 'submitting';
  room.round++;
  addChat(room,{type:'system',text:`🎴 Tur ${room.round} — Ortadaki kart rankı: ${room.centerCard.rank}`});
  broadcastState(room);
  broadcast(room.id,'new_round',{round:room.round, centerCard:room.centerCard});
  clearTimer(room);
  broadcast(room.id,'phase_timer',{duration:12000, phase:'submitting'});
  room.turnTimer = setTimeout(()=>autoSubmitAll(room), 12000);
}

function autoSubmitAll(room) {
  if (room.phase!=='submitting') return;
  room.players.filter(p=>!p.isOut).forEach(p=>{
    if (!room.submissions[p.id] && p.hand && p.hand.length>0) {
      const card = p.hand.shift();
      room.submissions[p.id] = {card, auto:true};
      room.submittedOrder.push(p.id);
    }
  });
  broadcastState(room);
  startRevealPhase(room);
}

function startRevealPhase(room) {
  clearTimer(room);
  room.phase = 'reveal';
  broadcast(room.id,'phase_timer',{duration:8000, phase:'reveal'});
  broadcastState(room);
  broadcast(room.id,'reveal_phase',{
    submissions: room.submittedOrder.map(id=>{
      const p = room.players.find(x=>x.id===id);
      return {playerId:id, playerName:p?.name, playerAvatar:p?.avatar};
    })
  });
  room.turnTimer = setTimeout(()=>{ if(room.phase==='reveal') endReveal(room); }, 8000);
}

function resolveBluff(room, accuserId, accusedId) {
  clearTimer(room);
  const accuser = room.players.find(p=>p.id===accuserId);
  const accused = room.players.find(p=>p.id===accusedId);
  const sub = room.submissions[accusedId];
  if (!sub||!accuser||!accused) return;
  const isBluff = sub.card.rank !== room.centerCard.rank;
  const penalty = room.mode==='highrisk'?2:1;
  let loser, msg;
  if (isBluff) {
    loser=accused;
    msg=`🃏 ${accused.name} YALAN söyledi! (${sub.card.rank}${sub.card.suit} oynadı, ${room.centerCard.rank} gerekiyordu) — ${penalty} can!`;
  } else {
    loser=accuser;
    msg=`✅ ${accused.name} doğruyu oynadı! ${accuser.name} haksız çıktı — ${penalty} can!`;
  }
  loser.hp = Math.max(0, loser.hp-penalty);
  if (loser.hp===0) { loser.isOut=true; addChat(room,{type:'system',text:`💀 ${loser.name} oyundan düştü!`}); }
  addChat(room,{type:'bluff_result',text:msg});
  broadcast(room.id,'bluff_resolved',{
    accuserId, accusedId, isBluff,
    actualCard:sub.card, centerCard:room.centerCard,
    loserId:loser.id, loserName:loser.name, penalty, msg
  });
  if (!checkWinner(room)) { broadcastState(room); setTimeout(()=>startRound(room), 4500); }
  else broadcastState(room);
}

function endReveal(room) {
  clearTimer(room); room.phase='idle'; broadcastState(room);
  setTimeout(()=>startRound(room), 2000);
}

io.on('connection', socket => {
  console.log('+', socket.id);

  socket.on('create_room', ({name,avatar,mode})=>{
    const roomId = Math.random().toString(36).slice(2,7).toUpperCase();
    const room = createRoom(roomId, socket.id, mode);
    rooms[roomId]=room;
    room.players.push({id:socket.id,socketId:socket.id,name,avatar:avatar||'☕',hp:5,hand:[],isOut:false});
    socket.join(roomId); socketToRoom[socket.id]={roomId};
    socket.emit('room_created',{roomId}); broadcastState(room);
  });

  socket.on('join_room', ({roomId,name,avatar})=>{
    const room=rooms[roomId];
    if (!room) return socket.emit('error',{msg:'Oda bulunamadı!'});
    if (room.status!=='lobby') return socket.emit('error',{msg:'Oyun başladı!'});
    if (room.players.length>=6) return socket.emit('error',{msg:'Oda dolu!'});
    if (room.players.find(p=>p.id===socket.id)) return;
    room.players.push({id:socket.id,socketId:socket.id,name,avatar:avatar||'☕',hp:5,hand:[],isOut:false});
    socket.join(roomId); socketToRoom[socket.id]={roomId};
    addChat(room,{type:'system',text:`${name} kahvehaneye girdi ☕`});
    broadcastState(room);
  });

  socket.on('spectate_room', ({roomId})=>{
    const room=rooms[roomId]; if (!room) return;
    socket.join(roomId+'_spec'); socket.emit('state',publicState(room,null));
  });

  socket.on('start_game', ()=>{
    const info=socketToRoom[socket.id]; if (!info) return;
    const room=rooms[info.roomId];
    if (!room||room.hostId!==socket.id) return;
    if (room.players.length<2) return socket.emit('error',{msg:'En az 2 oyuncu!'});
    room.deck=makeDeck();
    const perP=Math.min(8,Math.floor(52/room.players.length));
    let di=0;
    room.players.forEach(p=>{ p.hand=room.deck.splice(0,perP); p.hp=5; p.isOut=false; });
    room.status='playing'; room.round=0;
    addChat(room,{type:'system',text:'☕ Yalancılar Kahvesi açıldı!'});
    broadcast(room.id,'game_started',{});
    setTimeout(()=>startRound(room),1800);
  });

  socket.on('submit_card', ({cardIdx})=>{
    const info=socketToRoom[socket.id]; if (!info) return;
    const room=rooms[info.roomId];
    if (!room||room.phase!=='submitting') return socket.emit('error',{msg:'Şu an kart oynama zamanı değil!'});
    const player=room.players.find(p=>p.id===socket.id);
    if (!player||player.isOut) return;
    if (room.submissions[socket.id]) return socket.emit('error',{msg:'Zaten kart oynadın!'});
    if (!player.hand[cardIdx]) return socket.emit('error',{msg:'Geçersiz kart!'});
    const card=player.hand.splice(cardIdx,1)[0];
    room.submissions[socket.id]={card,auto:false};
    room.submittedOrder.push(socket.id);
    addChat(room,{type:'play',text:`${player.name} kartını kapattı ✓`});
    broadcast(room.id,'player_submitted',{playerId:socket.id,playerName:player.name,avatar:player.avatar});
    broadcastState(room);
    const alive=room.players.filter(p=>!p.isOut);
    if (alive.every(p=>room.submissions[p.id])) { clearTimer(room); setTimeout(()=>startRevealPhase(room),600); }
  });

  socket.on('call_bluff', ({targetId})=>{
    const info=socketToRoom[socket.id]; if (!info) return;
    const room=rooms[info.roomId];
    if (!room||room.phase!=='reveal') return socket.emit('error',{msg:'Şu an bluff zamanı değil!'});
    if (socket.id===targetId) return socket.emit('error',{msg:'Kendine bluff yapamazsın!'});
    if (!room.submissions[targetId]) return socket.emit('error',{msg:'Bu oyuncu kart oynamadı!'});
    room.phase='result'; clearTimer(room); broadcastState(room);
    resolveBluff(room,socket.id,targetId);
  });

  socket.on('send_emoji', ({emoji})=>{
    const info=socketToRoom[socket.id]; if (!info) return;
    const room=rooms[info.roomId]; if (!room) return;
    const player=room.players.find(p=>p.id===socket.id); if (!player) return;
    broadcast(room.id,'player_emoji',{playerId:socket.id,playerName:player.name,emoji});
  });

  socket.on('send_chat', ({text})=>{
    const info=socketToRoom[socket.id]; if (!info) return;
    const room=rooms[info.roomId]; if (!room) return;
    if (room.mode==='silent') return socket.emit('error',{msg:'Sessiz modda konuşamazsın!'});
    const player=room.players.find(p=>p.id===socket.id); if (!player) return;
    const msg={type:'chat-user',text:text.slice(0,100),playerId:socket.id,playerName:player.name};
    addChat(room,msg); broadcast(room.id,'chat_msg',msg);
  });

  socket.on('stream_vote', ({targetPlayerId})=>{
    const info=socketToRoom[socket.id]; if (!info) return;
    const room=rooms[info.roomId]; if (!room) return;
    room.streamVotes[socket.id]=targetPlayerId;
    const counts={};
    Object.values(room.streamVotes).forEach(id=>{counts[id]=(counts[id]||0)+1;});
    broadcast(room.id,'stream_votes',{votes:counts});
  });

  socket.on('disconnect', ()=>{
    const info=socketToRoom[socket.id]; if (!info) return;
    const room=rooms[info.roomId]; if (!room){delete socketToRoom[socket.id];return;}
    const player=room.players.find(p=>p.id===socket.id);
    if (player) {
      player.isOut=true;
      addChat(room,{type:'system',text:`${player.name} bağlantısı kesildi.`});
      if (room.status==='playing') {
        if (!checkWinner(room)) {
          if (room.phase==='submitting') {
            const alive=room.players.filter(p=>!p.isOut);
            if (alive.length>0&&alive.every(p=>room.submissions[p.id])){clearTimer(room);setTimeout(()=>startRevealPhase(room),600);}
          }
          broadcastState(room);
        } else broadcastState(room);
      } else broadcastState(room);
    }
    delete socketToRoom[socket.id];
  });
});

const PORT = process.env.PORT||3000;
server.listen(PORT, ()=>console.log(`☕ Yalancılar Kahvesi: http://localhost:${PORT}`));
