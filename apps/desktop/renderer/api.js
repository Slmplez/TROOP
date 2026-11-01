export async function call(promise) {
  const response = await promise;
  if (!response?.ok) throw Error(response?.error || "操作未完成");
  return response.value;
}
