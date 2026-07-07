export const openStandaloneMobileEditor = (memoId: string) => {
  const params = new URLSearchParams({
    memoId,
    returnTo: "/",
  });
  window.location.href = `/mobile-edit.html#${params.toString()}`;
};
