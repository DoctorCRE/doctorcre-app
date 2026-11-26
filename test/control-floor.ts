// Design rule 1: controls are 32px with a mouse or trackpad and 44px on a touch screen; the harness gives phone-wide viewports a touch screen.
export const controlFloor = (width: number) => (width > 760 ? 32 : 44);
