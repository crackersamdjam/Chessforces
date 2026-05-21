import { boardCellAt } from "./board.js";
import { isValidRailwayMove, isValidRoadStep } from "./movement.js";
import { isFriendly, pieceAt, teamOf } from "./state.js";

const ENEMY_HQ = {
	N: [
		{ r: 7, c: 0 },
		{ r: 9, c: 0 },
		{ r: 7, c: 16 },
		{ r: 9, c: 16 }
	],
	S: [
		{ r: 7, c: 0 },
		{ r: 9, c: 0 },
		{ r: 7, c: 16 },
		{ r: 9, c: 16 }
	],
	E: [
		{ r: 0, c: 7 },
		{ r: 0, c: 9 },
		{ r: 16, c: 7 },
		{ r: 16, c: 9 }
	],
	W: [
		{ r: 0, c: 7 },
		{ r: 0, c: 9 },
		{ r: 16, c: 7 },
		{ r: 16, c: 9 }
	]
};

function isEnemySeat(room, seat, other) {
	if (!other || other === seat) return false;
	if (room.gameMode === "2v2") return teamOf(room, seat) !== teamOf(room, other);
	return other !== seat;
}

/**
 * Legal play moves for a seat (same rules applyMove enforces, without mutating).
 * With biasToEnemyHq, prefers captures then cells closer to enemy HQ (2v2 smoke bot).
 */
export function findLegalPlayMoves(room, seat, { limit = 64, biasToEnemyHq = false } = {}) {
	const playerId = room.seatToPlayerId.get(seat);
	if (!playerId) return [];

	const targets = ENEMY_HQ[seat] ?? [];
	const distToEnemy = (r, c) => {
		if (!targets.length) return 0;
		return Math.min(...targets.map((t) => Math.abs(t.r - r) + Math.abs(t.c - c)));
	};

	const moves = [];
	for (const piece of room.pieces.values()) {
		if (piece.ownerId !== playerId || !piece.pos || piece.alive === false) continue;
		if (piece.type === "flag" || piece.type === "mine") continue;

		const from = piece.pos;
		for (const cell of room.board.cells) {
			if (cell.type === "inactive" || cell.type === "railonly") continue;
			const to = { r: cell.r, c: cell.c };
			if (to.r === from.r && to.c === from.c) continue;
			if (cell.type === "mountain" && piece.type !== "engineer") continue;

			if (!isValidRoadStep(room, from, to) && !isValidRailwayMove(room, piece, from, to)) {
				continue;
			}

			const target = pieceAt(room, to);
			if (target) {
				const targetSeat = room.players.get(target.ownerId)?.seat;
				if (!isEnemySeat(room, seat, targetSeat)) continue;
				if (cell.type === "camp") continue;
			}

			const capture = Boolean(target);
			const score = biasToEnemyHq ? (capture ? 1000 : 0) - distToEnemy(to.r, to.c) : capture ? 1 : 0;
			moves.push({ pieceId: piece.id, from, to, score, capture });
		}
	}

	if (biasToEnemyHq || moves.some((m) => m.capture)) {
		moves.sort((a, b) => b.score - a.score);
	}
	return moves.slice(0, limit).map(({ pieceId, to }) => ({ pieceId, to }));
}
