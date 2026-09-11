export interface NamedObject {
  schema: string
  name: string
  oid?: string
}

export interface NamedObjectEntry<T extends NamedObject> {
  kind: 'group' | 'item'
  key: string
  schema: string
  name: string
  objects: T[]
}

interface PrefixNode {
  count: number
  prefix: string
  children: Map<string, PrefixNode>
}

function prefixRoot(): PrefixNode {
  return { count: 0, prefix: '', children: new Map() }
}

function groupKey(namespace: string, schema: string, prefix: string): string {
  return `${namespace}\u0000${schema}\u0000${prefix}`
}

function itemKey<T extends NamedObject>(namespace: string, object: T, index: number): string {
  return `${namespace}\u0000item\u0000${object.oid ?? index}`
}

function tablePrefixes(name: string): string[] {
  let prefix = ''
  return name.split('_').map((part) => {
    prefix = prefix ? `${prefix}_${part}` : part
    return prefix
  })
}

function prefixNode(root: PrefixNode | undefined, parts: string[], end: number): PrefixNode | undefined {
  let node = root
  for (let i = 0; i <= end && node; i++) node = node.children.get(parts[i])
  return node
}

export function groupNamedObjects<T extends NamedObject>(
  objects: T[],
  enabled: boolean,
  namespace: string,
): NamedObjectEntry<T>[] {
  if (!enabled) {
    return objects.map((object, index) => ({
      kind: 'item',
      key: itemKey(namespace, object, index),
      schema: object.schema,
      name: object.name,
      objects: [object],
    }))
  }

  const roots = new Map<string, PrefixNode>()
  for (const object of objects) {
    const existingRoot = roots.get(object.schema)
    let node: PrefixNode
    if (existingRoot) {
      node = existingRoot
    } else {
      node = prefixRoot()
      roots.set(object.schema, node)
    }

    node.count++
    let prefix = ''
    for (const part of object.name.split('_')) {
      prefix = prefix ? `${prefix}_${part}` : part
      let child: PrefixNode | undefined = node.children.get(part)
      if (!child) {
        child = { count: 0, prefix, children: new Map() }
        node.children.set(part, child)
      }
      child.count++
      node = child
    }
  }

  const candidates = new Map<string, string | null>()
  const candidateMembers = new Map<string, T[]>()
  for (const [index, object] of objects.entries()) {
    let node = roots.get(object.schema)
    let longest: string | null = null
    for (const part of object.name.split('_')) {
      node = node?.children.get(part)
      if (!node) break
      if (node.count > 1) longest = node.prefix
    }

    const objectKey = itemKey(namespace, object, index)
    candidates.set(objectKey, longest)
    if (longest) {
      const key = groupKey(namespace, object.schema, longest)
      const group = candidateMembers.get(key) ?? []
      group.push(object)
      candidateMembers.set(key, group)
    }
  }

  const assignments = new Map<string, string | null>()
  const members = new Map<string, T[]>()
  for (const [index, object] of objects.entries()) {
    const objectKey = itemKey(namespace, object, index)
    let prefix = candidates.get(objectKey) ?? null
    const candidateMembersForObject = prefix ? candidateMembers.get(groupKey(namespace, object.schema, prefix)) : undefined
    if (prefix && candidateMembersForObject?.length === 1) {
      const parts = object.name.split('_')
      const prefixes = tablePrefixes(object.name)
      const candidateIndex = prefixes.indexOf(prefix)
      for (let i = candidateIndex - 1; i >= 0; i--) {
        const ancestor = prefixNode(roots.get(object.schema), parts, i)
        if (ancestor && ancestor.count > 1) {
          prefix = prefixes[i]
          break
        }
      }
    }

    assignments.set(objectKey, prefix)
    if (prefix) {
      const key = groupKey(namespace, object.schema, prefix)
      const group = members.get(key) ?? []
      group.push(object)
      members.set(key, group)
    }
  }

  const validGroups = new Set(
    [...members.entries()]
      .filter(([, group]) => group.length > 1)
      .map(([key]) => key),
  )
  const entries: NamedObjectEntry<T>[] = []
  const emittedGroups = new Set<string>()

  for (const [index, object] of objects.entries()) {
    const prefix = assignments.get(itemKey(namespace, object, index))
    const key = prefix ? groupKey(namespace, object.schema, prefix) : ''
    if (prefix && validGroups.has(key)) {
      if (!emittedGroups.has(key)) {
        emittedGroups.add(key)
        entries.push({
          kind: 'group',
          key: `group\u0000${key}`,
          schema: object.schema,
          name: prefix,
          objects: members.get(key) ?? [],
        })
      }
      continue
    }

    entries.push({
      kind: 'item',
      key: itemKey(namespace, object, index),
      schema: object.schema,
      name: object.name,
      objects: [object],
    })
  }

  return entries
}
