import type { TranslationKey } from "../i18n/language";

export const builtInAssetNameKeys: Record<string, TranslationKey> = {
  "desk-monitor": "editor.asset.name.deskMonitor",
  "desk-clear": "editor.asset.name.deskClear",
  "desk-laptop": "editor.asset.name.deskLaptop",
  "chair-front": "editor.asset.name.chairFront",
  "chair-back": "editor.asset.name.chairBack",
  "meeting-table": "editor.asset.name.meetingTable",
  whiteboard: "editor.asset.name.whiteboard",
  "sofa-sage": "editor.asset.name.sofaSage",
  armchair: "editor.asset.name.armchair",
  "coffee-table": "editor.asset.name.coffeeTable",
  reception: "editor.asset.name.reception",
  bookshelf: "editor.asset.name.bookshelf",
  cabinet: "editor.asset.name.cabinet",
  pantry: "editor.asset.name.pantry",
  "plant-large": "editor.asset.name.plantLarge",
  "plant-small": "editor.asset.name.plantSmall",
  "rug-sage": "editor.asset.name.rugSage",
  "rug-blue": "editor.asset.name.rugBlue",
  "water-cooler": "editor.asset.name.waterCooler",
  divider: "editor.asset.name.divider",
  screen: "editor.asset.name.screen",
  "original-plant": "editor.asset.name.originalPlant",
  "original-tree": "editor.asset.name.originalTree",
  "campus-tree-large": "editor.asset.name.campusTreeLarge",
  "campus-tree": "editor.asset.name.campusTree",
  "campus-tree-small": "editor.asset.name.campusTreeSmall",
  "campus-bush": "editor.asset.name.campusBush",
  "campus-berries": "editor.asset.name.campusBerries",
  "campus-house": "editor.asset.name.campusHouse",
  "campus-house-large": "editor.asset.name.campusHouseLarge",
  "campus-sign": "editor.asset.name.campusSign",
  "gdg-sign": "editor.asset.name.gdgSign",
};

export function localizedAssetName(
  assetId: string,
  originalName: string,
  translate: (key: TranslationKey) => string,
) {
  const key = builtInAssetNameKeys[assetId];
  return key ? translate(key) : originalName;
}
