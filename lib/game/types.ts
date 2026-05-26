export type Seat = "N" | "E" | "S" | "W";

export type Phase = "lobby" | "play" | "done";

export type Position = {
	r: number;
	c: number;
};

export type SetupLocalPosition = {
	depth: number;
	lane: number;
};

export type ClientToServerMessage =
	| { type: "set_name"; name?: string }
	| { type: "take_seat"; seat?: string }
	| { type: "leave_seat" }
	| { type: "set_ready"; ready?: boolean }
	| { type: "set_turn_duration"; seconds?: number }
	| { type: "place_piece"; pieceId?: string; pos?: Position | null }
	| { type: "move"; pieceId?: string; to?: Position | null }
	| { type: "forfeit" }
	| { type: "offer_draw" }
	| { type: "chat"; text?: string }
	| { type: "export_setup" }
	| { type: "import_setup"; setup?: unknown }
	| { type: "export_game" };

export type ServerToClientMessage =
	| { type: "hello"; playerId: string; seats: readonly Seat[]; reconnectToken: string; reconnectGraceMs: number }
	| { type: "state"; state: unknown }
	| { type: "presence" }
	| { type: "turn_skipped"; seat: Seat | null; nextSeat: Seat | null }
	| { type: "turn_duration_result"; ok: boolean; reason?: string; seconds?: number }
	| { type: "move_result"; ok: boolean; reason?: string }
	| {
			type: "forfeit_result";
			ok: boolean;
			reason?: string;
			seat?: Seat;
			by?: { id: string; name: string; seat: Seat | null };
	  }
	| { type: "draw_offer_result"; ok: boolean; reason?: string; seat?: Seat; offeredSeats?: Seat[]; accepted?: boolean }
	| { type: "chat"; from: { id: string; name: string; seat: Seat | null }; text: string; at: number }
	| { type: "setup_file"; ok: boolean; reason?: string; setup?: unknown }
	| { type: "import_setup_result"; ok: boolean; reason?: string }
	| { type: "game_file"; ok: boolean; reason?: string; game?: unknown };

export function isClientToServerMessage(value: unknown): value is ClientToServerMessage {
	return !!value && typeof value === "object" && "type" in value && typeof (value as { type?: unknown }).type === "string";
}
