import { boardCellAt, getRailAdj } from "./board.js";
import { eliminatePlayer, isFriendly, pieceAt } from "./state.js";

export function isValidRoadStep(room, from, to) {
	const dr = Math.abs(to.r - from.r), dc = Math.abs(to.c - from.c);
	if (dr + dc === 1) return true;
	if (dr === 1 && dc === 1) {
		const fc = boardCellAt(room.board, from);
		const tc = boardCellAt(room.board, to);
		return fc?.type === "camp" || tc?.type === "camp";
	}
	return false;
}

export function isValidRailwayMove(room, piece, from, to) {
	if (boardCellAt(room.board, from)?.type === "hq") return false;

	const adj = getRailAdj(room);
	const startKey = `${from.r},${from.c}`;
	const toKey   = `${to.r},${to.c}`;
	const ORTHO = [[0,1],[0,-1],[1,0],[-1,0]];

	if (piece.type === "engineer") {
		const fromCell = boardCellAt(room.board, from);
		const visited = new Set();
		const queue = [];

		if (fromCell?.type === "mountain") {
			visited.add(startKey);
			for (const [dr, dc] of ORTHO) {
				const nr = from.r + dr, nc = from.c + dc;
				const nk = `${nr},${nc}`;
				if (!adj.has(nk)) continue;
				if (pieceAt(room, {r: nr, c: nc})) continue;
				if (visited.has(nk)) continue;
				visited.add(nk);
				if (nk === toKey) return true;
				queue.push({r: nr, c: nc});
			}
		} else {
			if (!adj.has(startKey)) return false;
			visited.add(startKey);
			queue.push(from);
		}

		while (queue.length > 0) {
			const cur = queue.shift();
			for (const next of (adj.get(`${cur.r},${cur.c}`) ?? [])) {
				const nk = `${next.r},${next.c}`;
				if (visited.has(nk)) continue;
				visited.add(nk);
				if (nk === toKey) return true;
				if (pieceAt(room, next)) continue;
				queue.push(next);
			}
			for (const [dr, dc] of ORTHO) {
				const mr = cur.r + dr, mc = cur.c + dc;
				if (`${mr},${mc}` !== toKey) continue;
				const destCell = boardCellAt(room.board, {r: mr, c: mc});
				if (destCell?.type === "mountain") return true;
			}
		}
		return false;
	}

	if (!adj.has(startKey)) return false;

	const visited = new Set();

	function dfs(r, c, dr, dc) {
		const isFirstStep = dr === 0 && dc === 0;
		for (const next of (adj.get(`${r},${c}`) ?? [])) {
			const ndr = Math.sign(next.r - r);
			const ndc = Math.sign(next.c - c);
			const isDiag = (ndr !== 0 && ndc !== 0);

			if (isDiag) {
				const prevR = r - dr, prevC = c - dc;
				if (!isFirstStep && !(prevR < 5 || prevC < 5 || prevR > 11 || prevC > 11)) continue;
			} else {
				if ((dr !== 0 || dc !== 0) && (dr * ndr + dc * ndc) <= 0) continue;
			}

			const sk = `${next.r},${next.c},${ndr},${ndc}`;
			if (visited.has(sk)) continue;
			visited.add(sk);

			if (next.r === to.r && next.c === to.c) return true;
			if (pieceAt(room, next)) continue;

			if (dfs(next.r, next.c, ndr, ndc)) return true;
		}
		return false;
	}

	return dfs(from.r, from.c, 0, 0);
}

export function canMovePiece(room, piece) {
	if (!piece.alive || !piece.pos || piece.type === "flag" || piece.type === "mine") return false;
	const ownSeat = room.players.get(piece.ownerId)?.seat;
	if (!ownSeat) return false;
	const from = piece.pos;
	if (boardCellAt(room.board, from)?.type === "hq") return false;

	for (const cell of room.board.cells) {
		if (cell.type === "inactive" || cell.type === "railonly") continue;
		const to = { r: cell.r, c: cell.c };
		if (to.r === from.r && to.c === from.c) continue;

		if (cell.type === "mountain" && piece.type !== "engineer") continue;

		if (!isValidRoadStep(room, from, to) && !isValidRailwayMove(room, piece, from, to)) continue;

		const target = pieceAt(room, to);
		if (target) {
			const targetSeat = room.players.get(target.ownerId)?.seat;
			if (targetSeat && isFriendly(room, ownSeat, targetSeat)) continue;
			if (cell.type === "camp") continue;
		}

		return true;
	}
	return false;
}

export function hasMovablePieces(room, seat) {
	const playerId = room.seatToPlayerId.get(seat);
	if (!playerId) return false;
	for (const piece of room.pieces.values()) {
		if (piece.ownerId !== playerId) continue;
		if (canMovePiece(room, piece)) return true;
	}
	return false;
}

export function checkEliminations(room) {
	for (const [seat] of room.seatToPlayerId) {
		if (room.eliminatedSeats.has(seat)) continue;
		if (!hasMovablePieces(room, seat)) {
			eliminatePlayer(room, seat);
		}
	}
}
