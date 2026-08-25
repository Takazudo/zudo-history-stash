export interface DiffFixture {
  name: string;
  fromText: string;
  toText: string;
}

export const roundTripFixtures: DiffFixture[] = [
  {
    name: "plain ASCII",
    fromText: "first line\nsecond line\n",
    toText: "first line\nchanged line\n",
  },
  {
    name: "Japanese multiline",
    fromText: "春の朝\n静かな庭\n",
    toText: "春の朝\n賑やかな庭\n月明かり\n",
  },
  {
    name: "CRLF",
    fromText: "first\r\nsecond\r\n",
    toText: "first\r\nthird\r\n",
  },
  {
    name: "old side has no trailing newline",
    fromText: "first\nsecond",
    toText: "first\nsecond\n",
  },
  {
    name: "both sides have no trailing newline",
    fromText: "first\nsecond",
    toText: "first\nthird",
  },
  { name: "empty to nonempty", fromText: "", toText: "created\n" },
  { name: "nonempty to empty", fromText: "removed\n", toText: "" },
  { name: "single line", fromText: "before", toText: "after" },
];
