// Design rule 1: controls are 32px on a computer and keep 44px touch targets below laptop width.
export const controlFloor = (width: number) => (width >= 1024 ? 32 : 44);
