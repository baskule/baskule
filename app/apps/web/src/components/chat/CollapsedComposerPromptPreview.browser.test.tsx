import "~/index.css";

import { expect, it } from "vite-plus/test";

import { EMPTY_COMPOSER_CONTEXT_RECORDS } from "../composerContextPresentation";
import { render } from "../../../test/render";
import { CollapsedComposerPromptPreview } from "./CollapsedComposerPromptPreview";

it("leaves unknown skills as the text the user typed", async () => {
  await using screen = await render(
    <CollapsedComposerPromptPreview
      prompt="run $missing now"
      skills={[]}
      contextRecords={EMPTY_COMPOSER_CONTEXT_RECORDS}
      theme="dark"
    />,
    // The inert preview has no router-dependent children.
    { router: false },
  );
  const { container } = screen;

  expect(container.querySelector('[data-slot="context-chip"]')).toBeNull();
  expect(container.textContent).toBe("run $missing now");
});
