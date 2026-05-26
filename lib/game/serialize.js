import { isInBounds } from "./board.js";
import { PIECE_DEFS, SEATS } from "./constants.js";
import { validatePlacement } from "./placement.js";

export const GAME_FILE_FORMAT = "chessforces-game";
export const SETUP_FILE_FORMAT = "chessforces-setup";
export const GAME_FILE_VERSION = 1;
export const SETUP_FILE_VERSION = 1;
export const BOARD_SPEC_VERSION = 1;

const PIECE_COUNTS = new Map(PIECE_DEFS.map((def) => [def.type, def.count]));
const GAME_MODES = new Set(["ffa", "2v2"]);

export function exportSetup(room, playerId) {
	const player = room.players.get(playerId);
	if (!player?.seat) {
		throw new Error("You must take a seat before exporting a setup.");
	}
	return {
		format: SETUP_FILE_FORMAT,
		version: SETUP_FILE_VERSION,
		pieces: exportPersonalSetup(room, playerId, player.seat)
	};
}

export function exportGame(room) {
	const initialSetup = {};
	for (const seat of SEATS) {
		initialSetup[seat] = exportSeatPieces(room, seat, room.initialSetupByPieceId ?? null);
	}
	const moves = (room.moveHistory ?? []).map((move, idx) => serializeMove(room, move, idx + 1));
	return {
		format: GAME_FILE_FORMAT,
		version: GAME_FILE_VERSION,
		boardSpecVersion: BOARD_SPEC_VERSION,
		gameMode: room.gameMode ?? "ffa",
		meta: {
			exportedAt: new Date().toISOString(),
			roomId: room.id
		},
		initialSetup,
		moves,
		result: {
			phase: room.phase,
			winnerTeam: room.winnerTeam ?? null,
			reason: room.gameOverReason ?? null
		}
	};
}

export function parseSetupDocument(input) {
	assertObject(input, "Setup file must be a JSON object.");
	assertEqual(input.format, SETUP_FILE_FORMAT, "Unsupported setup format.");
	assertEqual(input.version, SETUP_FILE_VERSION, "Unsupported setup version.");
	const pieces = validatePersonalSetupPieces(input.pieces);
	return {
		format: SETUP_FILE_FORMAT,
		version: SETUP_FILE_VERSION,
		pieces
	};
}

export function parseGameDocument(input) {
	assertObject(input, "Game file must be a JSON object.");
	assertEqual(input.format, GAME_FILE_FORMAT, "Unsupported game format.");
	assertEqual(input.version, GAME_FILE_VERSION, "Unsupported game version.");
	assertEqual(input.boardSpecVersion, BOARD_SPEC_VERSION, "Unsupported board spec version.");
	assertGameMode(input.gameMode);
	const initialSetup = validateSeatSetupMap(input.initialSetup, true);
	const moves = validateMoves(input.moves);
	const result = validateResult(input.result);
	return {
		format: GAME_FILE_FORMAT,
		version: GAME_FILE_VERSION,
		boardSpecVersion: BOARD_SPEC_VERSION,
		gameMode: input.gameMode,
		meta: assertMaybeObject(input.meta, "Invalid game metadata."),
		initialSetup,
		moves,
		result
	};
}

export function applySetupToRoom(room, playerId, setupDoc) {
	const player = room.players.get(playerId);
	if (!player?.seat) {
		return { ok: false, reason: "You must take a seat before importing a setup." };
	}
	if (room.phase !== "lobby") {
		return { ok: false, reason: "Setup import is only allowed in the lobby." };
	}

	const playerPieces = Array.from(room.pieces.values()).filter((piece) => piece.ownerId === playerId);
	const prevPositions = new Map();
	for (const piece of playerPieces) {
		prevPositions.set(piece.id, piece.pos ? { r: piece.pos.r, c: piece.pos.c } : null);
	}

	try {
		const setup = parseSetupDocument(setupDoc);
		const keyToPiece = new Map();
		for (const piece of playerPieces) {
			keyToPiece.set(pieceSlotKey(piece), piece);
			piece.pos = null;
		}
		for (const entry of setup.pieces) {
			const piece = keyToPiece.get(pieceSlotKey(entry));
			if (!piece) {
				throw new Error(`Missing piece: ${entry.type}#${entry.slot}.`);
			}
			const absPos = localPosToBoardPos(player.seat, entry.pos);
			if (!isInBounds(room.board, absPos)) {
				throw new Error(`Out-of-bounds position: depth ${entry.pos.depth}, lane ${entry.pos.lane}.`);
			}
			if (pieceAtPos(room, absPos)) {
				throw new Error(`Overlapping setup position at ${absPos.r},${absPos.c}.`);
			}
			piece.pos = { r: absPos.r, c: absPos.c };
			if (!validatePlacement(room, piece, player)) {
				throw new Error(`Invalid placement for ${piece.type}#${piece.slot}.`);
			}
		}
		room.updatedAt = Date.now();
		return { ok: true };
	} catch (err) {
		for (const piece of playerPieces) {
			piece.pos = prevPositions.get(piece.id) ?? null;
		}
		return { ok: false, reason: err instanceof Error ? err.message : "Invalid setup file." };
	}
}

function exportPersonalSetup(room, playerId, seat) {
	return Array.from(room.pieces.values())
		.filter((piece) => piece.ownerId === playerId)
		.sort((a, b) => {
			if (a.type !== b.type) return a.type.localeCompare(b.type);
			const aSlot = Number.isInteger(a.slot) ? a.slot : 0;
			const bSlot = Number.isInteger(b.slot) ? b.slot : 0;
			if (aSlot !== bSlot) return aSlot - bSlot;
			return a.id.localeCompare(b.id);
		})
		.map((piece) => ({
			type: piece.type,
			slot: piece.slot ?? 0,
			pos: boardPosToLocalPos(seat, normalizePos(piece.pos))
		}));
}

function exportSeatPieces(room, seat, setupByPieceId = null) {
	return piecesForSeat(room, seat).map((piece) => ({
		type: piece.type,
		slot: piece.slot ?? 0,
		pos: normalizePos(setupByPieceId ? setupByPieceId[piece.id] : piece.pos)
	}));
}

function piecesForSeat(room, seat) {
	const playerId = room.seatToPlayerId.get(seat);
	if (!playerId) return [];
	return Array.from(room.pieces.values())
		.filter((piece) => piece.ownerId === playerId)
		.sort((a, b) => {
			if (a.type !== b.type) return a.type.localeCompare(b.type);
			const aSlot = Number.isInteger(a.slot) ? a.slot : 0;
			const bSlot = Number.isInteger(b.slot) ? b.slot : 0;
			if (aSlot !== bSlot) return aSlot - bSlot;
			return a.id.localeCompare(b.id);
		});
}

function serializeMove(room, move, ply) {
	const piece = room.pieces.get(move.pieceId);
	const bySeat = move.by ?? seatForOwnerId(room, piece?.ownerId) ?? null;
	const docMove = {
		ply,
		bySeat,
		piece: toPieceRef(room, piece, bySeat),
		from: normalizePos(move.from),
		to: normalizePos(move.to),
		capture: null,
		eliminatedSeats: Array.isArray(move.eliminatedSeats) ? [...move.eliminatedSeats] : []
	};
	if (move.capture) {
		const attacker = room.pieces.get(move.capture.attackerId);
		const defender = room.pieces.get(move.capture.defenderId);
		docMove.capture = {
			result: move.capture.result,
			attacker: toPieceRef(room, attacker, bySeat),
			defender: toPieceRef(room, defender, seatForOwnerId(room, defender?.ownerId))
		};
	}
	return docMove;
}

function toPieceRef(room, piece, fallbackSeat) {
	if (!piece) {
		return {
			seat: fallbackSeat ?? null,
			type: null,
			slot: null
		};
	}
	return {
		seat: seatForOwnerId(room, piece.ownerId) ?? fallbackSeat ?? null,
		type: piece.type,
		slot: Number.isInteger(piece.slot) ? piece.slot : 0
	};
}

function seatForOwnerId(room, ownerId) {
	return room.players.get(ownerId)?.seat ?? null;
}

function validateSeatSetupMap(value, requirePos) {
	assertObject(value, "Expected setup seats object.");
	const out = {};
	for (const seat of SEATS) {
		const entries = value[seat];
		if (!Array.isArray(entries)) {
			throw new Error(`Expected an array of pieces for seat ${seat}.`);
		}
		const typeCounts = new Map();
		const slotSeen = new Set();
		out[seat] = entries.map((entry) => {
			assertObject(entry, `Invalid piece entry for seat ${seat}.`);
			const type = String(entry.type ?? "");
			if (!PIECE_COUNTS.has(type)) {
				throw new Error(`Unknown piece type '${type}' for seat ${seat}.`);
			}
			const slot = Number(entry.slot);
			if (!Number.isInteger(slot) || slot < 0 || slot >= PIECE_COUNTS.get(type)) {
				throw new Error(`Invalid slot ${entry.slot} for ${type} (${seat}).`);
			}
			const key = `${type}:${slot}`;
			if (slotSeen.has(key)) {
				throw new Error(`Duplicate piece key ${type}#${slot} for seat ${seat}.`);
			}
			slotSeen.add(key);
			typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
			const pos = normalizePos(entry.pos);
			if (requirePos && pos === null) {
				throw new Error(`Missing position for ${type}#${slot} (${seat}).`);
			}
			return { type, slot, pos };
		});
		for (const def of PIECE_DEFS) {
			if ((typeCounts.get(def.type) ?? 0) !== def.count) {
				throw new Error(`Seat ${seat} has invalid count for ${def.type}.`);
			}
		}
	}
	return out;
}

function validatePersonalSetupPieces(value) {
	if (!Array.isArray(value)) {
		throw new Error("Expected setup pieces array.");
	}
	const typeCounts = new Map();
	const slotSeen = new Set();
	const out = value.map((entry) => {
		assertObject(entry, "Invalid setup piece entry.");
		const type = String(entry.type ?? "");
		if (!PIECE_COUNTS.has(type)) {
			throw new Error(`Unknown piece type '${type}'.`);
		}
		const slot = Number(entry.slot);
		if (!Number.isInteger(slot) || slot < 0 || slot >= PIECE_COUNTS.get(type)) {
			throw new Error(`Invalid slot ${entry.slot} for ${type}.`);
		}
		const key = `${type}:${slot}`;
		if (slotSeen.has(key)) {
			throw new Error(`Duplicate piece key ${type}#${slot}.`);
		}
		slotSeen.add(key);
		typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
		const pos = normalizeLocalPos(entry.pos);
		return { type, slot, pos };
	});
	for (const def of PIECE_DEFS) {
		if ((typeCounts.get(def.type) ?? 0) !== def.count) {
			throw new Error(`Invalid count for piece type ${def.type}.`);
		}
	}
	return out;
}

function validateMoves(value) {
	if (!Array.isArray(value)) throw new Error("Game moves must be an array.");
	return value.map((entry, idx) => {
		assertObject(entry, `Invalid move at index ${idx}.`);
		const ply = Number(entry.ply);
		if (!Number.isInteger(ply) || ply < 1) {
			throw new Error(`Invalid ply at index ${idx}.`);
		}
		const bySeat = String(entry.bySeat ?? "");
		if (!SEATS.includes(bySeat)) throw new Error(`Invalid bySeat '${bySeat}' at ply ${ply}.`);
		const piece = validatePieceRef(entry.piece, `piece at ply ${ply}`);
		const from = normalizePos(entry.from);
		const to = normalizePos(entry.to);
		if (!from || !to) throw new Error(`Move at ply ${ply} must include from/to.`);
		const out = {
			ply,
			bySeat,
			piece,
			from,
			to,
			capture: null,
			eliminatedSeats: validateEliminatedSeats(entry.eliminatedSeats, ply)
		};
		if (entry.capture !== null && entry.capture !== undefined) {
			assertObject(entry.capture, `Invalid capture at ply ${ply}.`);
			out.capture = {
				result: String(entry.capture.result ?? ""),
				attacker: validatePieceRef(entry.capture.attacker, `attacker at ply ${ply}`),
				defender: validatePieceRef(entry.capture.defender, `defender at ply ${ply}`)
			};
		}
		return out;
	});
}

function validatePieceRef(value, ctx) {
	assertObject(value, `Invalid ${ctx}.`);
	const seat = String(value.seat ?? "");
	if (!SEATS.includes(seat)) throw new Error(`Invalid seat in ${ctx}.`);
	const type = String(value.type ?? "");
	if (!PIECE_COUNTS.has(type)) throw new Error(`Invalid type '${type}' in ${ctx}.`);
	const slot = Number(value.slot);
	if (!Number.isInteger(slot) || slot < 0 || slot >= PIECE_COUNTS.get(type)) {
		throw new Error(`Invalid slot in ${ctx}.`);
	}
	return { seat, type, slot };
}

function validateResult(value) {
	assertObject(value, "Game result must be an object.");
	const phase = String(value.phase ?? "");
	if (!["lobby", "play", "done"].includes(phase)) throw new Error("Invalid game result phase.");
	return {
		phase,
		winnerTeam: value.winnerTeam ?? null,
		reason: value.reason ?? null
	};
}

function validateEliminatedSeats(value, ply) {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error(`Invalid eliminatedSeats at ply ${ply}.`);
	const seen = new Set();
	for (const seat of value) {
		if (!SEATS.includes(seat)) throw new Error(`Invalid eliminated seat '${seat}' at ply ${ply}.`);
		if (seen.has(seat)) throw new Error(`Duplicate eliminated seat '${seat}' at ply ${ply}.`);
		seen.add(seat);
	}
	return [...value];
}

function pieceSlotKey(piece) {
	return `${piece.type}:${piece.slot}`;
}

function pieceAtPos(room, pos) {
	for (const piece of room.pieces.values()) {
		if (piece.alive !== false && piece.pos && piece.pos.r === pos.r && piece.pos.c === pos.c) return piece;
	}
	return null;
}

function normalizePos(pos) {
	if (pos == null) return null;
	assertObject(pos, "Invalid position.");
	const r = Number(pos.r);
	const c = Number(pos.c);
	if (!Number.isInteger(r) || !Number.isInteger(c)) {
		throw new Error("Positions must use integer row/col values.");
	}
	return { r, c };
}

function normalizeLocalPos(pos) {
	assertObject(pos, "Invalid local setup position.");
	const depth = Number(pos.depth);
	const lane = Number(pos.lane);
	if (!Number.isInteger(depth) || depth < 0 || depth > 5) {
		throw new Error("Local position depth must be an integer between 0 and 5.");
	}
	if (!Number.isInteger(lane) || lane < 0 || lane > 4) {
		throw new Error("Local position lane must be an integer between 0 and 4.");
	}
	return { depth, lane };
}

function boardPosToLocalPos(seat, pos) {
	if (pos == null) return null;
	switch (seat) {
		case "N":
			return { depth: pos.r, lane: pos.c - 6 };
		case "S":
			return { depth: 16 - pos.r, lane: 10 - pos.c };
		case "W":
			return { depth: pos.c, lane: 10 - pos.r };
		case "E":
			return { depth: 16 - pos.c, lane: pos.r - 6 };
		default:
			throw new Error(`Unsupported seat '${seat}'.`);
	}
}

function localPosToBoardPos(seat, localPos) {
	switch (seat) {
		case "N":
			return { r: localPos.depth, c: 6 + localPos.lane };
		case "S":
			return { r: 16 - localPos.depth, c: 10 - localPos.lane };
		case "W":
			return { r: 10 - localPos.lane, c: localPos.depth };
		case "E":
			return { r: 6 + localPos.lane, c: 16 - localPos.depth };
		default:
			throw new Error(`Unsupported seat '${seat}'.`);
	}
}

function assertGameMode(mode) {
	if (!GAME_MODES.has(mode)) throw new Error(`Unsupported game mode '${mode}'.`);
}

function assertEqual(actual, expected, message) {
	if (actual !== expected) throw new Error(message);
}

function assertObject(value, message) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(message);
	}
}

function assertMaybeObject(value, message) {
	if (value == null) return null;
	assertObject(value, message);
	return value;
}
