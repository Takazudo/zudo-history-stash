import { Fragment } from "react";

const PATH_DELIMITER = /([/\\])/u;
const IS_PATH_DELIMITER = /^[/\\]$/u;

/** Add copy-safe wrapping opportunities after path delimiters. */
export function PathText({ value }: { value: string }) {
  return value.split(PATH_DELIMITER).map((part, index) => (
    <Fragment key={`${index}:${part}`}>
      {part}
      {IS_PATH_DELIMITER.test(part) ? <wbr /> : null}
    </Fragment>
  ));
}
