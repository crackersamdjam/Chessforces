export { SEATS, PHASES, PIECE_DEFS } from "./constants.js";
export { createBoard, boardCellAt, isInBounds, getRailAdj } from "./board.js";
export { homeInfoForSeat, isHQCell, validatePlacement } from "./placement.js";
export { resolveCapture } from "./combat.js";
export {
	isValidRoadStep,
	isValidRailwayMove,
	canMovePiece,
	hasMovablePieces,
	checkEliminations
} from "./movement.js";
export {
	createRoom,
	chooseSeat,
	pieceAt,
	ensurePieceSet,
	roomSnapshotFor,
	allPiecesPlaced,
	maybeAdvancePhase,
	startGame,
	nextOccupiedSeat,
	teamOf,
	eliminatePlayer,
	isFriendly,
	checkForWin
} from "./state.js";
export { applyPlacement, applyMove } from "./actions.js";
