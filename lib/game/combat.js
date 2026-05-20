export function resolveCapture(attacker, defender) {
	if (defender.type === "flag") {
		defender.alive = false;
		defender.pos = null;
		return { result: "flag", attackerId: attacker.id, defenderId: defender.id };
	}

	if (attacker.type === "bomb" || defender.type === "bomb") {
		attacker.alive = false;
		defender.alive = false;
		attacker.pos = null;
		defender.pos = null;
		return { result: "both", attackerId: attacker.id, defenderId: defender.id };
	}

	if (defender.type === "mine") {
		if (attacker.type === "engineer") {
			defender.alive = false;
			defender.pos = null;
			return { result: "attacker", attackerId: attacker.id, defenderId: defender.id };
		}
		attacker.alive = false;
		attacker.pos = null;
		return { result: "defender", attackerId: attacker.id, defenderId: defender.id };
	}

	if (typeof attacker.rank === "number" && typeof defender.rank === "number") {
		if (attacker.rank > defender.rank) {
			defender.alive = false;
			defender.pos = null;
			return { result: "attacker", attackerId: attacker.id, defenderId: defender.id };
		}
		if (attacker.rank < defender.rank) {
			attacker.alive = false;
			attacker.pos = null;
			return { result: "defender", attackerId: attacker.id, defenderId: defender.id };
		}
		attacker.alive = false;
		defender.alive = false;
		attacker.pos = null;
		defender.pos = null;
		return { result: "both", attackerId: attacker.id, defenderId: defender.id };
	}

	throw new Error("Invalid combat resolution");
}
