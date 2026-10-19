// El porcentaje también se expresa como entero: multiplicar dinero grande
// por un decimal binario puede cambiar un centavo justo en el redondeo.
export function porcentajeCentavos(centavos, porcentaje) {
  const puntos = Math.round(Number(porcentaje) * 100);
  return Number((BigInt(centavos) * BigInt(puntos) + 5000n) / 10000n);
}
