---
id: spore-lantern
kind: item
name: Spore Lantern
identity: Light that breathes.
state: shaped
why: ""
tags: []
fields:
  subkind: tool
  change: see in the Hollows without torches
  tradeoff: dims when you sprint
  route:
    - text: gather lumen spores
      needs:
        - lumen-spore
    - text: press at a spore shrine
attributes: {}
relations:
  - type: made_from
    target: lumen-spore
  - type: in_band
    target: hollows
  - type: conflicts
    target: cinder-sting
origin:
  by: user
ai_fields: []
created: 2026-11-01T12:00:00.000Z
updated: 2026-11-01T12:00:00.000Z
---
