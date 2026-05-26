import { boardCellAt, isInBounds } from "./board.js";
import { PHASES } from "./constants.js";
import { resolveCapture } from "./combat.js";
import { checkEliminations, isValidRailwayMove, isValidRoadStep } from "./movement.js";
import { validatePlacement } from "./placement.js";
import {
	checkForWin,
	eliminatePlayer,
	isFriendly,
	nextOccupiedSeat,
	pieceAt,
	resetTurnTimer
} from "./state.js";

function activeSeats(room) {
	return Array.from(room.seatToPlayerId.keys()).filter((seat) => !room.eliminatedSeats.has(seat));
}

export function applyPlacement(room, playerId, pieceId, pos) {
	if (room.phase !== PHASES.LOBBY) {
		return { ok: false, reason: "Placement is only allowed in the lobby." };
	}

	const player = room.players.get(playerId);
	if (!player?.seat) {
		return { ok: false, reason: "You must take a seat before placing pieces." };
	}

	const piece = room.pieces.get(pieceId);
	if (!piece || piece.ownerId !== playerId) {
		return { ok: false, reason: "Invalid piece." };
	}

	if (pos !== null && !isInBounds(room.board, pos)) {
		return { ok: false, reason: "Position is out of bounds." };
	}

	if (pos !== null && pieceAt(room, pos)) {
		return { ok: false, reason: "Cell is already occupied." };
	}

	const prevPos = piece.pos;
	piece.pos = pos;
	if (!validatePlacement(room, piece, player)) {
		piece.pos = prevPos;
		return { ok: false, reason: "Invalid placement." };
	}

	room.updatedAt = Date.now();
	return { ok: true };
}

export function applyMove(room, playerId, pieceId, to) {
	if (room.phase !== PHASES.PLAY) {
		return { ok: false, reason: "The game is not in play." };
	}

	const player = room.players.get(playerId);
	if (!player?.seat) {
		return { ok: false, reason: "You must take a seat to move." };
	}

	if (room.turnSeat !== player.seat) {
		return { ok: false, reason: "It is not your turn." };
	}

	if (!isInBounds(room.board, to)) {
		return { ok: false, reason: "Destination is out of bounds." };
	}

	const piece = room.pieces.get(pieceId);
	if (!piece || piece.ownerId !== playerId || !piece.pos || piece.alive === false) {
		return { ok: false, reason: "Invalid piece." };
	}

	if (piece.type === "flag" || piece.type === "mine") {
		return { ok: false, reason: "Flags and mines cannot move." };
	}

	const from = piece.pos;
	if (from.r === to.r && from.c === to.c) {
		return { ok: false, reason: "Piece is already at that position." };
	}
	const fromCell = boardCellAt(room.board, from);
	if (fromCell?.type === "hq") {
		return { ok: false, reason: "Pieces cannot move out of HQ (大本营) cells." };
	}

	if (!isValidRoadStep(room, from, to) && !isValidRailwayMove(room, piece, from, to)) {
		return { ok: false, reason: "Invalid move: not a valid road or railway path." };
	}

	const toCell = boardCellAt(room.board, to);
	if (toCell?.type === "railonly") {
		return { ok: false, reason: "Pieces cannot land on a rail pass-through cell." };
	}
	if (toCell?.type === "mountain" && piece.type !== "engineer") {
		return { ok: false, reason: "Only engineers (工兵) can enter mountain (山界) cells." };
	}

	const target = pieceAt(room, to);
	if (target) {
		const targetSeat = room.players.get(target.ownerId)?.seat;
		if (isFriendly(room, player.seat, targetSeat)) {
			return { ok: false, reason: "Cannot capture a friendly piece." };
		}
	}
	if (target && boardCellAt(room.board, to)?.type === "camp") {
		return { ok: false, reason: "Pieces on camp (行营) cells are immune to capture." };
	}

	let capture = null;
	const eliminatedBefore = new Set(room.eliminatedSeats);
	if (target) {
		capture = resolveCapture(piece, target);
		if (piece.alive !== false) piece.pos = to;

		if (target.type === "marshal" && target.alive === false) {
			for (const p of room.pieces.values()) {
				if (p.ownerId === target.ownerId && p.type === "flag") {
					p.flagRevealed = true;
				}
			}
		}
		if (target.type === "flag" && target.alive === false) {
			const victimSeat = room.players.get(target.ownerId)?.seat;
			if (victimSeat) eliminatePlayer(room, victimSeat);
		}
	} else {
		piece.pos = to;
	}

	checkEliminations(room);

	const lastMove = { by: player.seat, pieceId: piece.id, from, to, capture };
	room.lastMove = lastMove;
	const eliminatedThisMove = [];
	for (const seat of room.eliminatedSeats) {
		if (!eliminatedBefore.has(seat)) eliminatedThisMove.push(seat);
	}
	room.moveHistory.push({
		...lastMove,
		eliminatedSeats: eliminatedThisMove,
		at: Date.now()
	});
	if (room.phase !== PHASES.DONE) {
		room.turnSeat = nextOccupiedSeat(room, room.turnSeat);
		resetTurnTimer(room);
	}
	room.drawOfferSeats = new Set();

	checkForWin(room);
	room.updatedAt = Date.now();

	return { ok: true, capture, lastMove };
}

export function applyForfeit(room, playerId) {
	if (room.phase !== PHASES.PLAY) {
		return { ok: false, reason: "You can only forfeit during play." };
	}

	const player = room.players.get(playerId);
	if (!player?.seat) {
		return { ok: false, reason: "You must take a seat before forfeiting." };
	}
	if (room.eliminatedSeats.has(player.seat)) {
		return { ok: false, reason: "You are already eliminated." };
	}

	eliminatePlayer(room, player.seat);
	if (room.turnSeat === player.seat) {
		room.turnSeat = nextOccupiedSeat(room, room.turnSeat);
	}
	room.drawOfferSeats = new Set();
	checkForWin(room);
	resetTurnTimer(room);
	room.updatedAt = Date.now();
	return { ok: true, seat: player.seat };
}

export function applyOfferDraw(room, playerId) {
	if (room.phase !== PHASES.PLAY) {
		return { ok: false, reason: "You can only offer a draw during play." };
	}

	const player = room.players.get(playerId);
	if (!player?.seat) {
		return { ok: false, reason: "You must take a seat before offering a draw." };
	}
	if (room.eliminatedSeats.has(player.seat)) {
		return { ok: false, reason: "Eliminated players cannot offer a draw." };
	}

	if (!room.drawOfferSeats) room.drawOfferSeats = new Set();
	if (room.drawOfferSeats.has(player.seat)) {
		return { ok: false, reason: "You already offered a draw." };
	}

	room.drawOfferSeats.add(player.seat);
	const liveSeats = activeSeats(room);
	const allOffered = liveSeats.length > 1 && liveSeats.every((seat) => room.drawOfferSeats.has(seat));
	if (allOffered) {
		room.phase = PHASES.DONE;
		room.winnerTeam = null;
		room.gameOverReason = "draw";
		room.turnStartedAt = null;
		room.turnDeadlineAt = null;
	}

	room.updatedAt = Date.now();
	return {
		ok: true,
		seat: player.seat,
		offeredSeats: Array.from(room.drawOfferSeats),
		accepted: allOffered
	};
}
