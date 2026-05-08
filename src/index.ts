import { WORDS } from './words';
import { getHTML } from './html';

export interface Env {
  GAME_ROOM: DurableObjectNamespace;
}

interface Card {
  word: string;
  team: 'red' | 'blue' | 'neutral' | 'assassin';
  revealed: boolean;
}

type Role = 'red-spymaster' | 'red-operative' | 'blue-spymaster' | 'blue-operative';

interface Player {
  id: string;
  name: string;
  role: Role;
}

interface Clue {
  word: string;
  number: number;
  team: 'red' | 'blue';
  guessesLeft: number;
}

interface CheatVote {
  initiatorId: string;
  initiatorName: string;
  startedAt: number;
  approvals: string[]; // player IDs who approved (initiator auto-approves)
}

interface GameState {
  id: string;
  roomCode: string;
  cards: Card[];
  currentTeam: 'red' | 'blue';
  phase: 'lobby' | 'clue' | 'guess' | 'over';
  redScore: number;
  blueScore: number;
  winner: null | 'red' | 'blue';
  gameOver: boolean;
  gameOverReason: null | string;
  players: Player[];
  currentClue: Clue | null;
  clueHistory: Clue[];
  currentVotes: Record<string, number>;
  cheatTally: number;
  activeCheatVote: CheatVote | null;
  reshuffleVotes: string[];
}

const ACCUSED_NAME = 'Ms DTM';

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function generatePlayerId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 12; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

function createBoard(): { cards: Card[]; startingTeam: 'red' | 'blue' } {
  const words = shuffle(WORDS).slice(0, 25);
  const startingTeam: 'red' | 'blue' = Math.random() > 0.5 ? 'red' : 'blue';
  const otherTeam = startingTeam === 'red' ? 'blue' : 'red';
  const assignments: Card['team'][] = [
    ...Array(9).fill(startingTeam),
    ...Array(8).fill(otherTeam),
    ...Array(7).fill('neutral'),
    'assassin',
  ];
  const shuffled = shuffle(assignments);
  const cards: Card[] = words.map((word, i) => ({
    word,
    team: shuffled[i],
    revealed: false,
  }));
  return { cards, startingTeam };
}

function canStartGame(players: Player[]): boolean {
  return (
    players.some(p => p.role === 'red-spymaster') &&
    players.some(p => p.role === 'blue-spymaster') &&
    players.some(p => p.role === 'red-operative') &&
    players.some(p => p.role === 'blue-operative')
  );
}

function getTeamOperatives(game: GameState, team: 'red' | 'blue'): Player[] {
  const role = team === 'red' ? 'red-operative' : 'blue-operative';
  return game.players.filter(p => p.role === role);
}

function eligibleCheatVoters(game: GameState): Player[] {
  return game.players.filter(p => p.name !== ACCUSED_NAME);
}

function filterStateForPlayer(game: GameState, playerId: string | null): object {
  const player = playerId ? game.players.find(p => p.id === playerId) : null;
  const isSpymaster = player?.role === 'red-spymaster' || player?.role === 'blue-spymaster';

  const cards = game.cards.map(card => {
    if (card.revealed || isSpymaster) return card;
    return { word: card.word, team: 'hidden' as const, revealed: false };
  });

  // Vote summary
  const voteSummary: Record<number, number> = {};
  for (const [, idx] of Object.entries(game.currentVotes)) {
    voteSummary[idx] = (voteSummary[idx] || 0) + 1;
  }
  const myVote = playerId && game.currentVotes[playerId] !== undefined ? game.currentVotes[playerId] : null;
  const teamOps = getTeamOperatives(game, game.currentTeam);

  // Safe players — strip IDs from other players
  const safePlayers = game.players.map(p => ({
    name: p.name,
    role: p.role,
    ...(p.id === playerId ? { id: p.id } : {}),
  }));

  // Cheat vote — surface counts but not raw player IDs
  const eligible = eligibleCheatVoters(game);
  const cheatVote = game.activeCheatVote
    ? {
        initiatorName: game.activeCheatVote.initiatorName,
        approvals: game.activeCheatVote.approvals.length,
        needed: eligible.length,
        myApproval: playerId ? game.activeCheatVote.approvals.includes(playerId) : false,
      }
    : null;
  const isAccused = player?.name === ACCUSED_NAME;

  return {
    id: game.id,
    roomCode: game.roomCode,
    cards,
    currentTeam: game.currentTeam,
    phase: game.phase,
    redScore: game.redScore,
    blueScore: game.blueScore,
    winner: game.winner,
    gameOver: game.gameOver,
    gameOverReason: game.gameOverReason,
    players: safePlayers,
    currentClue: game.currentClue,
    clueHistory: game.clueHistory,
    currentVotes: voteSummary,
    cheatTally: game.cheatTally,
    cheatVote,
    reshuffleVotes: (game.reshuffleVotes ?? []).length,
    reshuffleNeeded: game.players.length,
    myReshuffleVote: !!playerId && (game.reshuffleVotes ?? []).includes(playerId),
    _isSpymaster: isSpymaster,
    _playerId: playerId,
    _playerRole: player?.role ?? null,
    _playerName: player?.name ?? null,
    _playerTeam: player ? (player.role.startsWith('red') ? 'red' : 'blue') : null,
    _myVote: myVote,
    _totalOperatives: teamOps.length,
    _votesIn: Object.keys(game.currentVotes).length,
    _canStart: game.phase === 'lobby' && canStartGame(game.players),
    _canAccuse: !isAccused && eligible.length > 0,
    _accusedName: ACCUSED_NAME,
  };
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

export class GameRoom {
  private state: DurableObjectState;
  private game: GameState | null = null;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  private async loadGame(): Promise<GameState | null> {
    if (this.game) return this.game;
    const stored = (await this.state.storage.get<GameState>('game')) ?? null;
    if (stored) {
      // Migrate older saves: cheat tally starts at 3, no active vote
      if (typeof stored.cheatTally !== 'number') stored.cheatTally = 3;
      if (stored.activeCheatVote === undefined) stored.activeCheatVote = null;
      if (!Array.isArray(stored.reshuffleVotes)) stored.reshuffleVotes = [];
    }
    this.game = stored;
    return this.game;
  }

  private async saveGame(): Promise<void> {
    if (this.game) {
      await this.state.storage.put('game', this.game);
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const action = url.searchParams.get('action');

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    try {
      switch (action) {
        case 'create': return await this.handleCreate(request);
        case 'join': return await this.handleJoin(request);
        case 'start': return await this.handleStart(request);
        case 'state': return await this.handleGetState(request);
        case 'clue': return await this.handleClue(request);
        case 'guess': return await this.handleGuess(request);
        case 'end-turn': return await this.handleEndTurn(request);
        case 'new-round': return await this.handleNewRound(request);
        case 'reshuffle': return await this.handleReshuffle(request);
        case 'cheat-start': return await this.handleCheatStart(request);
        case 'cheat-vote': return await this.handleCheatVote(request);
        case 'cheat-cancel': return await this.handleCheatCancel(request);
        default: return jsonResponse({ error: 'Unknown action' }, 400);
      }
    } catch (e: any) {
      return jsonResponse({ error: e.message || 'Internal error' }, 500);
    }
  }

  private async handleCreate(request: Request): Promise<Response> {
    const body = await request.json() as { roomCode: string };
    const { cards, startingTeam } = createBoard();
    this.game = {
      id: body.roomCode,
      roomCode: body.roomCode,
      cards,
      currentTeam: startingTeam,
      phase: 'lobby',
      redScore: cards.filter(c => c.team === 'red').length,
      blueScore: cards.filter(c => c.team === 'blue').length,
      winner: null,
      gameOver: false,
      gameOverReason: null,
      players: [],
      currentClue: null,
      clueHistory: [],
      currentVotes: {},
      cheatTally: 3,
      activeCheatVote: null,
      reshuffleVotes: [],
    };
    await this.saveGame();
    return jsonResponse({ roomCode: this.game.roomCode });
  }

  private async handleJoin(request: Request): Promise<Response> {
    const body = await request.json() as { name: string; role: Role };
    const game = await this.loadGame();
    if (!game) return jsonResponse({ error: 'Game not found' }, 404);

    const trimmedName = body.name.trim() || 'Anonymous';

    // Duplicate name check — same person rejoining
    const existing = game.players.find(p => p.name === trimmedName);
    if (existing) {
      if (existing.role === body.role) {
        // Same name, same role — idempotent rejoin
        await this.saveGame();
        return jsonResponse({ playerId: existing.id, game: filterStateForPlayer(game, existing.id) });
      }
      // Same name, different role — they want to switch
      if ((body.role === 'red-spymaster' || body.role === 'blue-spymaster') &&
          game.players.some(p => p.role === body.role && p.name !== trimmedName)) {
        return jsonResponse({ error: 'That spymaster role is already taken' }, 400);
      }
      // Remove old entry, will re-add below
      game.players = game.players.filter(p => p.name !== trimmedName);
    }

    // Spymaster uniqueness
    if ((body.role === 'red-spymaster' || body.role === 'blue-spymaster') &&
        game.players.some(p => p.role === body.role)) {
      return jsonResponse({ error: 'That spymaster role is already taken' }, 400);
    }

    const playerId = generatePlayerId();
    game.players.push({ id: playerId, name: trimmedName, role: body.role });
    await this.saveGame();
    return jsonResponse({ playerId, game: filterStateForPlayer(game, playerId) });
  }

  private async handleStart(request: Request): Promise<Response> {
    const body = await request.json() as { playerId: string };
    const game = await this.loadGame();
    if (!game) return jsonResponse({ error: 'Game not found' }, 404);
    if (game.phase !== 'lobby') return jsonResponse({ error: 'Game already started' }, 400);
    if (!canStartGame(game.players)) return jsonResponse({ error: 'Need at least 1 spymaster + 1 operative per team' }, 400);

    game.phase = 'clue';
    await this.saveGame();
    return jsonResponse(filterStateForPlayer(game, body.playerId));
  }

  private async handleGetState(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const playerId = url.searchParams.get('playerId');
    const game = await this.loadGame();
    if (!game) return jsonResponse({ error: 'Game not found' }, 404);
    return jsonResponse(filterStateForPlayer(game, playerId));
  }

  private async handleClue(request: Request): Promise<Response> {
    const body = await request.json() as { playerId: string; word: string; number: number };
    const game = await this.loadGame();
    if (!game) return jsonResponse({ error: 'Game not found' }, 404);
    if (game.phase !== 'clue') return jsonResponse({ error: 'Not in clue phase' }, 400);

    const player = game.players.find(p => p.id === body.playerId);
    if (!player) return jsonResponse({ error: 'Player not found' }, 400);

    const expectedRole = game.currentTeam === 'red' ? 'red-spymaster' : 'blue-spymaster';
    if (player.role !== expectedRole) return jsonResponse({ error: 'Not your turn to give a clue' }, 400);

    const num = Math.max(0, Math.min(25, body.number));
    const clue: Clue = {
      word: body.word.trim().toUpperCase(),
      number: num,
      team: game.currentTeam,
      // 0 = unlimited guesses (Codenames rules), otherwise number + 1 bonus guess
      guessesLeft: num === 0 ? 99 : num + 1,
    };

    game.currentClue = clue;
    game.clueHistory.push(clue);
    game.phase = 'guess';
    game.currentVotes = {};
    await this.saveGame();
    return jsonResponse(filterStateForPlayer(game, body.playerId));
  }

  private async handleGuess(request: Request): Promise<Response> {
    const body = await request.json() as { playerId: string; cardIndex: number };
    const game = await this.loadGame();
    if (!game) return jsonResponse({ error: 'Game not found' }, 404);
    if (game.phase !== 'guess') return jsonResponse({ error: 'Not in guess phase' }, 400);
    if (game.gameOver) return jsonResponse({ error: 'Game is over' }, 400);

    const player = game.players.find(p => p.id === body.playerId);
    if (!player) return jsonResponse({ error: 'Player not found' }, 400);

    const expectedRole = game.currentTeam === 'red' ? 'red-operative' : 'blue-operative';
    if (player.role !== expectedRole) return jsonResponse({ error: 'Not your turn to guess' }, 400);

    const card = game.cards[body.cardIndex];
    if (!card || card.revealed) return jsonResponse({ error: 'Invalid card' }, 400);

    // Record vote
    game.currentVotes[body.playerId] = body.cardIndex;

    // Check consensus
    const teamOps = getTeamOperatives(game, game.currentTeam);
    const allVoted = teamOps.every(op => game.currentVotes[op.id] !== undefined);

    if (allVoted) {
      const votes = teamOps.map(op => game.currentVotes[op.id]);
      const allAgree = votes.every(v => v === votes[0]);

      if (allAgree) {
        const chosenCard = game.cards[votes[0]];
        chosenCard.revealed = true;
        game.currentVotes = {};

        game.redScore = game.cards.filter(c => c.team === 'red' && !c.revealed).length;
        game.blueScore = game.cards.filter(c => c.team === 'blue' && !c.revealed).length;

        if (chosenCard.team === 'assassin') {
          game.gameOver = true;
          game.phase = 'over';
          game.winner = game.currentTeam === 'red' ? 'blue' : 'red';
          game.gameOverReason = game.currentTeam.toUpperCase() + ' hit the assassin!';
        } else if (chosenCard.team === game.currentTeam) {
          if ((chosenCard.team === 'red' && game.redScore === 0) ||
              (chosenCard.team === 'blue' && game.blueScore === 0)) {
            game.gameOver = true;
            game.phase = 'over';
            game.winner = chosenCard.team;
            game.gameOverReason = chosenCard.team.charAt(0).toUpperCase() + chosenCard.team.slice(1) + ' found all their agents!';
          } else if (game.currentClue) {
            game.currentClue.guessesLeft--;
            if (game.currentClue.guessesLeft <= 0) {
              game.currentTeam = game.currentTeam === 'red' ? 'blue' : 'red';
              game.currentClue = null;
              game.phase = 'clue';
            }
          }
        } else {
          game.currentTeam = game.currentTeam === 'red' ? 'blue' : 'red';
          game.currentClue = null;
          game.phase = 'clue';
        }
      } else {
        game.currentVotes = {};
      }
    }

    await this.saveGame();
    return jsonResponse(filterStateForPlayer(game, body.playerId));
  }

  private async handleEndTurn(request: Request): Promise<Response> {
    const body = await request.json() as { playerId: string };
    const game = await this.loadGame();
    if (!game) return jsonResponse({ error: 'Game not found' }, 404);
    if (game.phase !== 'guess') return jsonResponse({ error: 'Cannot end turn now' }, 400);
    if (game.gameOver) return jsonResponse({ error: 'Game is over' }, 400);

    const player = game.players.find(p => p.id === body.playerId);
    if (!player) return jsonResponse({ error: 'Player not found' }, 400);

    const expectedRole = game.currentTeam === 'red' ? 'red-operative' : 'blue-operative';
    if (player.role !== expectedRole) return jsonResponse({ error: 'Not your turn' }, 400);

    game.currentTeam = game.currentTeam === 'red' ? 'blue' : 'red';
    game.currentClue = null;
    game.phase = 'clue';
    game.currentVotes = {};
    await this.saveGame();
    return jsonResponse(filterStateForPlayer(game, body.playerId));
  }

  private async handleCheatStart(request: Request): Promise<Response> {
    const body = await request.json() as { playerId: string };
    const game = await this.loadGame();
    if (!game) return jsonResponse({ error: 'Game not found' }, 404);
    if (game.activeCheatVote) return jsonResponse({ error: 'A cheat vote is already in progress' }, 400);

    const player = game.players.find(p => p.id === body.playerId);
    if (!player) return jsonResponse({ error: 'Player not found' }, 400);
    if (player.name === ACCUSED_NAME) return jsonResponse({ error: 'The accused cannot start their own vote' }, 403);

    const eligible = eligibleCheatVoters(game);
    game.activeCheatVote = {
      initiatorId: player.id,
      initiatorName: player.name,
      startedAt: Date.now(),
      approvals: [player.id],
    };

    // If the initiator is the only eligible voter, the vote passes immediately
    if (game.activeCheatVote.approvals.length >= eligible.length) {
      game.cheatTally += 1;
      game.activeCheatVote = null;
    }

    await this.saveGame();
    return jsonResponse(filterStateForPlayer(game, body.playerId));
  }

  private async handleCheatVote(request: Request): Promise<Response> {
    const body = await request.json() as { playerId: string; approve: boolean };
    const game = await this.loadGame();
    if (!game) return jsonResponse({ error: 'Game not found' }, 404);
    if (!game.activeCheatVote) return jsonResponse({ error: 'No cheat vote in progress' }, 400);

    const player = game.players.find(p => p.id === body.playerId);
    if (!player) return jsonResponse({ error: 'Player not found' }, 400);
    if (player.name === ACCUSED_NAME) return jsonResponse({ error: 'The accused cannot vote' }, 403);

    if (body.approve === false) {
      // A single rejection cancels the vote — needs to be unanimous
      game.activeCheatVote = null;
    } else {
      if (!game.activeCheatVote.approvals.includes(player.id)) {
        game.activeCheatVote.approvals.push(player.id);
      }
      const eligible = eligibleCheatVoters(game);
      if (game.activeCheatVote.approvals.length >= eligible.length) {
        game.cheatTally += 1;
        game.activeCheatVote = null;
      }
    }

    await this.saveGame();
    return jsonResponse(filterStateForPlayer(game, body.playerId));
  }

  private async handleCheatCancel(request: Request): Promise<Response> {
    const body = await request.json() as { playerId: string };
    const game = await this.loadGame();
    if (!game) return jsonResponse({ error: 'Game not found' }, 404);
    if (!game.activeCheatVote) return jsonResponse({ error: 'No cheat vote in progress' }, 400);

    const player = game.players.find(p => p.id === body.playerId);
    if (!player) return jsonResponse({ error: 'Player not found' }, 400);
    if (player.id !== game.activeCheatVote.initiatorId) {
      return jsonResponse({ error: 'Only the initiator can cancel the vote' }, 403);
    }

    game.activeCheatVote = null;
    await this.saveGame();
    return jsonResponse(filterStateForPlayer(game, body.playerId));
  }

  private async handleNewRound(request: Request): Promise<Response> {
    const body = await request.json() as { playerId: string };
    const game = await this.loadGame();
    if (!game) return jsonResponse({ error: 'Game not found' }, 404);

    const { cards, startingTeam } = createBoard();
    game.cards = cards;
    game.currentTeam = startingTeam;
    game.phase = canStartGame(game.players) ? 'clue' : 'lobby';
    game.redScore = cards.filter(c => c.team === 'red').length;
    game.blueScore = cards.filter(c => c.team === 'blue').length;
    game.winner = null;
    game.gameOver = false;
    game.gameOverReason = null;
    game.currentClue = null;
    game.clueHistory = [];
    game.currentVotes = {};
    game.reshuffleVotes = [];
    await this.saveGame();
    return jsonResponse(filterStateForPlayer(game, body.playerId));
  }

  private async handleReshuffle(request: Request): Promise<Response> {
    const body = await request.json() as { playerId: string };
    const game = await this.loadGame();
    if (!game) return jsonResponse({ error: 'Game not found' }, 404);
    if (game.phase === 'lobby') return jsonResponse({ error: 'Game has not started' }, 400);

    const player = game.players.find(p => p.id === body.playerId);
    if (!player) return jsonResponse({ error: 'Player not found' }, 400);

    if (!Array.isArray(game.reshuffleVotes)) game.reshuffleVotes = [];
    const voted = game.reshuffleVotes.includes(player.id);
    if (voted) {
      game.reshuffleVotes = game.reshuffleVotes.filter(id => id !== player.id);
    } else {
      game.reshuffleVotes.push(player.id);
    }

    const allVoted = game.reshuffleVotes.length >= game.players.length;
    if (allVoted) {
      const { cards, startingTeam } = createBoard();
      game.cards = cards;
      game.currentTeam = startingTeam;
      game.phase = 'clue';
      game.redScore = cards.filter(c => c.team === 'red').length;
      game.blueScore = cards.filter(c => c.team === 'blue').length;
      game.winner = null;
      game.gameOver = false;
      game.gameOverReason = null;
      game.currentClue = null;
      game.clueHistory = [];
      game.currentVotes = {};
      game.reshuffleVotes = [];
    }

    await this.saveGame();
    return jsonResponse(filterStateForPlayer(game, body.playerId));
  }
}

// ============================================================
// Worker entry — routes requests to the correct Durable Object
// ============================================================

function generateRoomCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function getStub(env: Env, roomCode: string): DurableObjectStub {
  const id = env.GAME_ROOM.idFromName(roomCode.toUpperCase());
  return env.GAME_ROOM.get(id);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    // Serve frontend
    if (request.method === 'GET' && pathname === '/') {
      return new Response(getHTML(), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    // Create game
    if (request.method === 'POST' && pathname === '/api/create') {
      const roomCode = generateRoomCode();
      const stub = getStub(env, roomCode);
      return stub.fetch(new Request('https://do/?action=create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomCode }),
      }));
    }

    // Join game
    if (request.method === 'POST' && pathname === '/api/join') {
      const body = await request.json() as { gameId: string; name: string; role: string };
      const stub = getStub(env, body.gameId);
      return stub.fetch(new Request('https://do/?action=join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: body.name, role: body.role }),
      }));
    }

    // Start game
    if (request.method === 'POST' && pathname === '/api/start') {
      const body = await request.json() as { gameId: string; playerId: string };
      const stub = getStub(env, body.gameId);
      return stub.fetch(new Request('https://do/?action=start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerId: body.playerId }),
      }));
    }

    // Get game state
    const gameMatch = pathname.match(/^\/api\/game\/([A-Za-z0-9]{4})$/);
    if (request.method === 'GET' && gameMatch) {
      const code = gameMatch[1].toUpperCase();
      const playerId = url.searchParams.get('playerId') || '';
      const stub = getStub(env, code);
      return stub.fetch(new Request(`https://do/?action=state&playerId=${playerId}`, {
        method: 'GET',
      }));
    }

    // Give clue
    if (request.method === 'POST' && pathname === '/api/clue') {
      const body = await request.json() as { gameId: string; playerId: string; word: string; number: number };
      const stub = getStub(env, body.gameId);
      return stub.fetch(new Request('https://do/?action=clue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerId: body.playerId, word: body.word, number: body.number }),
      }));
    }

    // Guess
    if (request.method === 'POST' && pathname === '/api/guess') {
      const body = await request.json() as { gameId: string; playerId: string; cardIndex: number };
      const stub = getStub(env, body.gameId);
      return stub.fetch(new Request('https://do/?action=guess', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerId: body.playerId, cardIndex: body.cardIndex }),
      }));
    }

    // End turn
    if (request.method === 'POST' && pathname === '/api/end-turn') {
      const body = await request.json() as { gameId: string; playerId: string };
      const stub = getStub(env, body.gameId);
      return stub.fetch(new Request('https://do/?action=end-turn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerId: body.playerId }),
      }));
    }

    // New round
    if (request.method === 'POST' && pathname === '/api/new-round') {
      const body = await request.json() as { gameId: string; playerId: string };
      const stub = getStub(env, body.gameId);
      return stub.fetch(new Request('https://do/?action=new-round', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerId: body.playerId }),
      }));
    }

    // Reshuffle the board mid-game (when a board is unplayable)
    if (request.method === 'POST' && pathname === '/api/reshuffle') {
      const body = await request.json() as { gameId: string; playerId: string };
      const stub = getStub(env, body.gameId);
      return stub.fetch(new Request('https://do/?action=reshuffle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerId: body.playerId }),
      }));
    }

    // Start a "Did Masi cheat?" vote
    if (request.method === 'POST' && pathname === '/api/cheat-start') {
      const body = await request.json() as { gameId: string; playerId: string };
      const stub = getStub(env, body.gameId);
      return stub.fetch(new Request('https://do/?action=cheat-start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerId: body.playerId }),
      }));
    }

    // Approve / reject the cheat vote
    if (request.method === 'POST' && pathname === '/api/cheat-vote') {
      const body = await request.json() as { gameId: string; playerId: string; approve: boolean };
      const stub = getStub(env, body.gameId);
      return stub.fetch(new Request('https://do/?action=cheat-vote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerId: body.playerId, approve: body.approve }),
      }));
    }

    // Initiator cancels the cheat vote
    if (request.method === 'POST' && pathname === '/api/cheat-cancel') {
      const body = await request.json() as { gameId: string; playerId: string };
      const stub = getStub(env, body.gameId);
      return stub.fetch(new Request('https://do/?action=cheat-cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerId: body.playerId }),
      }));
    }

    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    });
  },
};
