import { describe, expect, it } from "vite-plus/test";
import {
  initialWorkspaceTabsState,
  workspaceTabsReducer,
  workspaceToolbarHeight,
} from "./workspace-tabs-state";

describe("workspace root navigation", () => {
  it("rejects the excluded Pull requests tab and retains the chat search", () => {
    let state = initialWorkspaceTabsState();
    state = workspaceTabsReducer(state, { type: "scroll", tab: "threads", offset: 640 });
    state = workspaceTabsReducer(state, { type: "search" });
    state = workspaceTabsReducer(state, { type: "query", query: "keyboard" });
    expect(workspaceTabsReducer(state, { type: "select", tab: "pullRequests" })).toBe(state);
    expect(state.selectedTab).toBe("threads");
    expect(state.tabs.threads.query).toBe("keyboard");
    expect(workspaceTabsReducer(state, { type: "cancel" }).tabs.threads.scrollOffset).toBe(640);
  });

  it("clear keeps search active without losing the position cancel restores", () => {
    let state = initialWorkspaceTabsState();
    state = workspaceTabsReducer(state, { type: "scroll", tab: "threads", offset: 500 });
    state = workspaceTabsReducer(state, { type: "search" });
    state = workspaceTabsReducer(state, { type: "query", query: "diff" });
    state = workspaceTabsReducer(state, { type: "scroll", tab: "threads", offset: 80 });
    state = workspaceTabsReducer(state, { type: "query", query: "" });
    state = workspaceTabsReducer(state, { type: "search" });
    expect(state.tabs.threads).toMatchObject({
      query: "",
      searchMode: "active",
      searchEntryOffset: 500,
    });
    expect(workspaceTabsReducer(state, { type: "cancel" }).tabs.threads.scrollOffset).toBe(500);
  });

  it("reserves space for both Android toolbar rows when expanded", () => {
    expect(workspaceToolbarHeight("expanded")).toBeGreaterThan(
      workspaceToolbarHeight("resting") * 2,
    );
  });

  it("a late native blur cannot reopen a cancelled search", () => {
    let state = workspaceTabsReducer(initialWorkspaceTabsState(), { type: "search" });
    state = workspaceTabsReducer(state, { type: "cancel" });
    expect(workspaceTabsReducer(state, { type: "expand" })).toBe(state);
  });

  it("a blur from the previous native tab cannot open search in the selected tab", () => {
    let state = workspaceTabsReducer(initialWorkspaceTabsState(), { type: "search" });
    state = workspaceTabsReducer(state, { type: "query", query: "keyboard" });
    state = workspaceTabsReducer(state, { type: "select", tab: "pullRequests" });
    state = workspaceTabsReducer(state, { type: "expand", tab: "threads" });
    expect(state.tabs.threads).toMatchObject({ query: "keyboard", searchMode: "expanded" });
    expect(state.tabs.pullRequests.searchMode).toBe("resting");
    expect(workspaceTabsReducer(state, { type: "select", tab: "pullRequests" })).toBe(state);
  });
});
