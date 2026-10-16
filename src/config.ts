// Calidad gráfica: el único sitio donde se ajusta cuánto trabaja la gráfica (y cuánto calienta el equipo).
// No hay menú: se cambia QUALITY aquí o, para probar, con ?q=alta|media|baja en la URL.

export interface Quality {
  pixelRatio: number;     // resolución máxima (× tamaño CSS del lienzo, limitada por la pantalla)
  minPixelRatio: number;  // la resolución dinámica no baja de aquí
  fpsCap: number;         // límite de fotogramas por segundo
  shadowMap: number;      // lado del mapa de sombras (texeles)
  shadowRange: number;    // media anchura (m) de la zona con sombras alrededor del jugador
  grassNear: number;      // briznas del anillo cercano (hasta 30 m)
  grassFar: number;       // briznas del anillo lejano (de 22 a 75 m)
}

const PRESETS: Record<string, Quality> = {
  alta: { pixelRatio: 1.5, minPixelRatio: 1.0, fpsCap: 60, shadowMap: 3072, shadowRange: 75, grassNear: 230000, grassFar: 90000 },
  media: { pixelRatio: 1.25, minPixelRatio: 1.0, fpsCap: 60, shadowMap: 2048, shadowRange: 70, grassNear: 200000, grassFar: 75000 },
  baja: { pixelRatio: 1.0, minPixelRatio: 0.75, fpsCap: 45, shadowMap: 1024, shadowRange: 60, grassNear: 120000, grassFar: 45000 },
};

const QUALITY = 'media';

const params = new URLSearchParams(location.search);
export const Q: Quality = { ...(PRESETS[params.get('q') ?? ''] ?? PRESETS[QUALITY]) };
if (params.has('fps')) Q.fpsCap = Number(params.get('fps'));   // pruebas de rendimiento (?fps=1000 = sin límite)
