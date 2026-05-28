// @ts-nocheck
const PIECE_LABELS = {
	marshal: "司令(40)",
	general: "军长(39)",
	major_general: "师长(38)",
	brigadier: "旅长(37)",
	colonel: "团长(36)",
	major: "营长(35)",
	captain: "连长(34)",
	lieutenant: "排长(33)",
	engineer: "工兵(1)",
	bomb: "炸弹(0)",
	mine: "地雷(X)",
	flag: "军旗($)"
};

export function buildReplayFromGameDoc(doc) {
	validateGameDoc(doc);
	const piecesByKey = new Map();
	for (const seat of ["N", "E", "S", "W"]) {
		for (const entry of doc.initialSetup[seat]) {
			const key = pieceKey({ seat, type: entry.type, slot: entry.slot });
			piecesByKey.set(key, {
				ownerSeat: seat,
				type: entry.type,
				slot: entry.slot,
				label: PIECE_LABELS[entry.type] ?? entry.type,
				pos: entry.pos ? { r: entry.pos.r, c: entry.pos.c } : null
			});
		}
	}

	const snapshots = [makeSnapshot(piecesByKey, null)];
	for (const move of doc.moves) {
		const piece = piecesByKey.get(pieceKey(move.piece));
		if (!piece || !piece.pos) throw new Error(`Replay move ${move.ply} references missing piece.`);
		piece.pos = { r: move.to.r, c: move.to.c };
		if (move.capture) {
			const attacker = piecesByKey.get(pieceKey(move.capture.attacker));
			const defender = piecesByKey.get(pieceKey(move.capture.defender));
			if (move.capture.result === "attacker" || move.capture.result === "flag") {
				if (defender) defender.pos = null;
			} else if (move.capture.result === "defender") {
				if (attacker) attacker.pos = null;
			} else if (move.capture.result === "both") {
				if (attacker) attacker.pos = null;
				if (defender) defender.pos = null;
			}
		}
		for (const seat of move.eliminatedSeats ?? []) {
			for (const otherPiece of piecesByKey.values()) {
				if (otherPiece.ownerSeat === seat) otherPiece.pos = null;
			}
		}
		snapshots.push(makeSnapshot(piecesByKey, move));
	}

	return {
		moves: doc.moves,
		snapshots,
		result: doc.result
	};
}

function makeSnapshot(piecesByKey, lastMove) {
	const pieceByCell = new Map();
	for (const piece of piecesByKey.values()) {
		if (!piece.pos) continue;
		pieceByCell.set(`${piece.pos.r},${piece.pos.c}`, {
			ownerSeat: piece.ownerSeat,
			label: piece.label
		});
	}
	return { pieceByCell, lastMove };
}

function pieceKey(piece) {
	return `${piece.seat}:${piece.type}:${piece.slot}`;
}

function validateGameDoc(doc) {
	if (!doc || typeof doc !== "object") throw new Error("Replay file must be a JSON object.");
	if (doc.format !== "chessforces-game") throw new Error("Unsupported replay format.");
	if (doc.version !== 1) throw new Error("Unsupported replay version.");
	if (doc.boardSpecVersion !== 1) throw new Error("Unsupported board spec version.");
	for (const seat of ["N", "E", "S", "W"]) {
		if (!Array.isArray(doc.initialSetup?.[seat])) throw new Error(`Missing initial setup for seat ${seat}.`);
	}
	if (!Array.isArray(doc.moves)) throw new Error("Replay moves must be an array.");
}
