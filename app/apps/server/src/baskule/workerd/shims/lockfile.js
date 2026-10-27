// proper-lockfile patches graceful-fs over celld's fs; a DO is single-instance, so no lock is needed.
export const lock = async () => async () => {};
export const unlock = async () => {};
export const check = async () => false;
export const lockSync = () => () => {};
export default { lock, unlock, check, lockSync };
