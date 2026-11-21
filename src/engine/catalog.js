// Indexes the official asset catalog (src/data/catalog.json, built by tools/build-catalog.cjs).

export function buildCatalog(raw) {
  const frameIndex = new Map();
  for (const sheet of raw.sheets) {
    for (const [name, rect] of Object.entries(sheet.frames)) {
      frameIndex.set(sheet.pack + '/' + name, { file: sheet.file, x: rect[0], y: rect[1], w: rect[2], h: rect[3] });
    }
  }
  const frame = (pack, asset) => frameIndex.get(pack + '/' + asset) || null;
  return {
    raw,
    foodDensity: raw.foodDensity,
    textures: raw.textures,
    hideSpaces: raw.hideSpaces,
    props: raw.props,
    foods: raw.foods,
    animals: raw.animals,
    textureById: new Map(raw.textures.map(t => [t.id, t])),
    hideSpaceById: new Map(raw.hideSpaces.map(h => [h.id, { ...h, frame: frame(h.pack, h.asset) }])),
    propById: new Map(raw.props.map(p => [p.id, { ...p, frame: frame(p.pack, p.asset) }])),
    foodById: new Map(raw.foods.map(f => [f.id, f])),
    animalByLevel: new Map(raw.animals.map(a => [a.level, a])),
    sheets: raw.sheets.map(s => s.file),
    frame
  };
}
