# Product Design Plan: Notion-Like Workspace App Without AI

## Goal

Build a Notion-like workspace app with the basic features users expect from Notion, but without AI.

The app should focus on pages, blocks, databases, templates, search, and sharing. The goal is not to copy Notion exactly. The goal is to build a clean workspace system where users can organize notes, projects, tasks, docs, and simple databases in one place.

## Core Product Idea

The app should work like a flexible workspace.

Users should be able to create pages, nest pages under other pages, add different types of content blocks, and create databases that can be viewed in different ways.

The main structure should be:

- Workspace
  - Pages
    - Child Pages
    - Blocks
  - Databases
    - Database Records

Each database record should also be able to open like a normal page.

## Main Features

### 1. Workspace

The workspace is the top-level container.

It should include: workspace name, users, settings, pages, shared content, trash, templates, search.

The first version can support one workspace per user. Multi-workspace support can be added later.

### 2. Pages

Pages are the main unit of content.

Each page should include: title, icon, optional cover image, page content, child pages, created date, last edited date, created by, last edited by, archive/delete option.

Pages should support nesting. A user should be able to create a page inside another page and move it later.

The sidebar should show the page tree.

### 3. Block Editor

The editor is the main part of the app. Every piece of page content should be a block.

Basic block types: text, heading 1, heading 2, heading 3, bulleted list, numbered list, to-do checkbox, toggle, quote, divider, callout, image, file, code block, table, child page, database.

The editor should support: slash menu, drag and drop, block reorder, block duplicate, block delete, indent and outdent, copy and paste, markdown shortcuts, keyboard controls.

The editor should feel fast and simple. Do not overbuild it in the first version.

### 4. Databases

Databases are what make this more than a notes app.

A database should be a group of records. Each record should also open as a page.

Basic database fields: text, number, select, multi-select, date, person, checkbox, URL, email, phone, file, created time, created by, last edited time, last edited by.

Database views to build first: table, list, board.

Views to add later: calendar, gallery, timeline, form.

The first version should focus on table, list, and board. That is enough to support notes, tasks, project tracking, asset tracking, and simple work systems.

### 5. Database Records

Each database row should have two parts: structured properties and a full page body.

Example: a task record can have status, owner, due date, priority, project. Then inside the record page, the user can add notes, files, checklists, and comments.

This keeps the app flexible.

### 6. Templates

Templates should save users from rebuilding the same layouts.

Template types: page template, database template, database record template, starter workspace template.

Basic templates to include: meeting notes, project plan, task tracker, bug tracker, decision log, personal notes, weekly planning, content calendar.

Templates should be stored as reusable page/block structures. When a user creates from a template, the app should copy that structure into a new page or record.

### 7. Search

Search should work across the workspace.

Search should include: page titles, page content, database records, database properties, comments later.

The first version can use basic database search. More advanced search can be added later.

### 8. Sharing and Permissions

Start with simple sharing.

Permission levels: owner, can edit, can comment, can view, no access.

Basic rules:

- Workspace owners can manage everything.
- Page owners can share pages.
- Child pages inherit parent permissions by default.
- Permissions can be changed at the page level.
- Database records should follow database permissions.

Do not start with complex enterprise permissions. Add that later only if needed.

### 9. Comments

Comments should come after the editor and databases are stable.

Comment features: page comments, block comments, mentions, resolve comment, notification when mentioned.

This gives teams enough collaboration without needing live multiplayer editing in the first release.

### 10. Activity History

Add a simple activity log.

Track: page created, page edited, page moved, page deleted, database record created, database record updated, user invited, permission changed.

This helps users trust the app and see what changed.

### 11. Import and Export

Export should be added early.

Export formats: Markdown, HTML, PDF, CSV for databases, JSON backup later.

Import can come later. Import formats: Markdown, CSV, HTML, Notion import later.

Export is more important than import in the first version. Users need to know their data is not trapped.

## MVP Scope

The MVP should include:

- User login
- Workspace
- Sidebar
- Nested pages
- Block editor
- Basic blocks
- Slash menu
- Drag and drop blocks
- Database table view
- Database list view
- Database board view
- Database records as pages
- Page templates
- Database templates
- Basic sharing
- Basic search
- Markdown export
- CSV export

Do not include in MVP: AI, real-time editing, offline mode, mobile app, formula system, automations, public website publishing, marketplace, advanced integrations, complex admin controls.

## Recommended Build Path

### Phase 1: App Foundation

Set up authentication, workspace model, page model, sidebar, nested page support, page create/edit/delete, trash/archive, basic search by page title.

Deliverable: a basic workspace where users can create and organize pages.

### Phase 2: Block Editor

Add block data model, text blocks, headings, lists, to-do blocks, toggles, quote and divider, slash menu, drag and drop, copy/paste, keyboard shortcuts.

Deliverable: a working block-based editor.

### Phase 3: Databases

Create database model, database properties, database records; make records open as pages; add table view, list view, board view, filter, sort, CSV export.

Deliverable: users can build task trackers, project boards, and simple databases.

### Phase 4: Templates

Create page templates, database templates, record templates, template picker, duplicate page option.

Deliverable: users can quickly create repeatable workspaces and records.

### Phase 5: Sharing

Invite user to workspace, share page with user, set page permission, inherited permissions, comments, mentions, notifications.

Deliverable: small teams can work together in the app.

### Phase 6: Product Polish

Improve search, add favorites, recent pages, backlinks, page history, improve export, performance cleanup, fix editor edge cases.

Deliverable: a stable version 1 product.

## Technical Direction

### Frontend

React or Next.js, TypeScript, TipTap/Lexical/ProseMirror for the editor, TanStack Query for API state, Zustand or Redux Toolkit for UI state, dnd-kit for drag and drop, TanStack Table for database tables, Tailwind or CSS modules for styling.

Do not build the full editor engine from scratch unless there is a strong reason. Use an editor framework and build the block system around it.

### Backend

Node.js with NestJS or Fastify, PostgreSQL, Redis, S3-compatible file storage, background worker for exports/search indexing/notifications/file processing, WebSockets later for live collaboration.

### Data Model

Core tables: users, workspaces, workspace_members, pages, blocks, databases, database_properties, database_records, database_values, views, view_filters, view_sorts, permissions, comments, templates, files, audit_events, notifications.

Page: id, workspace_id, parent_page_id, title, icon, cover_file_id, created_by, created_at, updated_at, archived_at.

Block: id, page_id, parent_block_id, type, content_json, sort_order, created_by, created_at, updated_at, archived_at.

Database: id, page_id, name, created_at, updated_at.

Database property: id, database_id, name, type, settings_json, sort_order.

Database record: id, database_id, page_id, created_at, updated_at.

Database value: id, record_id, property_id, value_json.

## Design Rules

- Keep the app simple first.
- Do not add AI.
- Do not start with mobile.
- Do not start with offline mode.
- Do not build every database property at once.
- Do not build complex permissions too early.
- Do not make the editor too complicated in the first release.
- Focus on speed, clean structure, and reliable data.

## Hard Parts

The block editor will be the hardest part. The database system will be the second hardest part. Permissions need to be planned early. Real-time editing, offline mode, formula support, and mobile should wait.

## Version 1 Feature Target

Version 1 should allow a user to: create an account, create a workspace, create pages, nest pages, add blocks, move blocks, create databases, create database records, open records as pages, use table/list/board views, create templates, share pages, comment on pages, search workspace content, export pages and databases.

That is enough to provide the basic Notion-style experience without adding AI or advanced platform features.
