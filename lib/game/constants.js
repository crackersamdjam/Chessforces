export const SEATS = /** @type {const} */ (["N", "E", "S", "W"]);

export const PHASES = /** @type {const} */ ({
	LOBBY: "lobby",
	PLAY: "play",
	DONE: "done"
});

export const PIECE_DEFS = [
	{ type: "marshal", label: "司令(40)", rank: 9, count: 1 },
	{ type: "general", label: "军长(39)", rank: 8, count: 1 },
	{ type: "major_general", label: "师长(38)", rank: 7, count: 2 },
	{ type: "brigadier", label: "旅长(37)", rank: 6, count: 2 },
	{ type: "colonel", label: "团长(36)", rank: 5, count: 2 },
	{ type: "major", label: "营长(35)", rank: 4, count: 2 },
	{ type: "captain", label: "连长(34)", rank: 3, count: 3 },
	{ type: "lieutenant", label: "排长(33)", rank: 2, count: 3 },
	{ type: "engineer", label: "工兵(1)", rank: 1, count: 3 },
	{ type: "bomb", label: "炸弹(0)", rank: null, count: 2 },
	{ type: "mine", label: "地雷(X)", rank: null, count: 3 },
	{ type: "flag", label: "军旗($)", rank: null, count: 1 }
];
