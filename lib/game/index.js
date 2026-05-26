export { SEATS, PHASES } from "./constants.js";
export { createBoard, boardCellAt } from "./board.js";
export { isHQCell, validatePlacement } from "./placement.js";
export { resolveCapture } from "./combat.js";
export {
	isValidRoadStep,
	isValidRailwayMove,
	checkEliminations
} from "./movement.js";
export {
	createRoom,
	DEFAULT_TURN_DURATION_MS,
	MIN_TURN_DURATION_SEC,
	MAX_TURN_DURATION_SEC,
	ensurePieceSet,
	roomSnapshotFor,
	allPiecesPlaced,
	resolveGameMode,
	maybeAdvancePhase,
	startGame,
	nextOccupiedSeat,
	eliminatePlayer,
	checkForWin,
	resetTurnTimer
} from "./state.js";
export { applyPlacement, applyMove } from "./actions.js";
export { enemyHqTargetsForSeat, findLegalPlayMoves } from "./play-moves.js";
export {
	GAME_FILE_FORMAT,
	SETUP_FILE_FORMAT,
	GAME_FILE_VERSION,
	SETUP_FILE_VERSION,
	BOARD_SPEC_VERSION,
	exportSetup,
	exportGame,
	parseSetupDocument,
	parseGameDocument,
	applySetupToRoom
} from "./serialize.js";
