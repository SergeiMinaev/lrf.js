export function run(c) {
  const runner = new Runner(c);
  c.$emit = (name, detail) => emit(c.rootNode, name, detail);
  if (c.onCreated) c.onCreated();
  runner.run();
}


class Runner {
  constructor(c) {
    this.c = c;
    this.isFirstRun = true;
    if (typeof c.rootNode == 'string') {
      this.rootNode = document.getElementById(c.rootNode);
      c.rootNode = this.rootNode;
    } else {
      this.rootNode = c.rootNode;
    }
    this.tpl = document.getElementById(c.tpl).content.cloneNode(true);
    this.context = {};
    this.render = () => this._render();
  }

  run() {
    this.prepareTpl();
    this.domTree = this.tpl.cloneNode(true);
    observer(this.render, this.c.tpl, this.isDeleted);
  }

  _render() {
    this.context = {};
    if (this.isFirstRun) {
      this.rootNode.append(this.tpl.cloneNode(true)); 
      if (this.c.onMounted) this.c.onMounted();
    }
    this.isFirstRun = false;
    this.processNodes(this.tpl, this.rootNode);
  }

  isDeleted = () => {
    return !this.isFirstRun && !this.rootNode.isConnected;
  }

  prepareTpl() {
    this.markNode(this.tpl);
  }

  markNode(node) {
    if (node.nodeName != '#document-fragment') {
      node.setAttribute('data-id', Math.random());
    }
    Array.from(node.children).forEach(child => {
      const ignoredNodeNames = ['#text', '#comment'];
      if (!ignoredNodeNames.includes(child.nodeName)) {
          this.markNode(child);
      }
    });
  }

  processNodes(tplNode, domParent) {
    if (tplNode.nodeName != '#document-fragment') {
      domParent = this.processNode(tplNode, domParent);
    }
    if (domParent === false) {
      return;
    }
    // Чтобы нода с '@for' не обрабатывалась дважды.
    if (!tplNode.attributes?.['@for']) {
      this.processChildren(tplNode, domParent);
    }
  }

  processChildren(tplNode, domParent) {
    Array.from(tplNode.children).forEach(tplChild => {
      const ignoredNodeNames = ['#text', '#comment'];
      if (!ignoredNodeNames.includes(tplChild.nodeName)) {
          this.processNodes(tplChild, domParent);
      }
    });
  }

  processNode(tplNode, domParent) {
    const nodeId = tplNode.getAttribute('data-id');
    let domNode = domParent.querySelector(`[data-id="${nodeId}"]`);
    const isChanged = this.processIf(tplNode, domParent);
    if (isChanged) {
      this.processEvents(tplNode, domParent);
      return false;
    }
    const isCmpFound = this.processComponents(tplNode, domParent);
    if (isCmpFound) {
      return false;
    }
    this.processLoop(tplNode, domParent);
    this.processAttrs(tplNode, domParent);
    this.processEvents(tplNode, domParent);
    return domNode;
  }

  processComponents(tplNode, domParent) {
    if (!tplNode.nodeName.startsWith('C-')) return false;
    const compName = tplNode.nodeName.toLowerCase().replace('c-', '');
    const domNode = nodesById(domParent, nodeId(tplNode))[0];
    if (domNode.getAttribute('data-created')) {
      this.processComponentProps(domNode.__cmp, tplNode, domParent);
      return true;
    }

    const cmp = new this.c.components[compName]();
    cmp.rootNode = domNode;
    domNode.__cmp = cmp;
    domNode.setAttribute('data-created', '1');
    const inner = cmp.rootNode.children[0];
    if (inner) cmp.rootNode.replaceWith(inner);
    this.processComponentProps(cmp, tplNode, domParent);
    run(cmp);
    return true;
  }

  processIf(tplNode, domParent) {
    let isChanged = false;
    if (tplNode.attributes['@if']) {
      const domNode = nodesById(domParent, nodeId(tplNode))[0];
      const expr = tplNode.attributes['@if'].value;
      const isTrue = fixExprResult(this.interpolate(expr));
      if (!isTrue) {
        // Нода заменяется слотом только если ещё не заменена.
        if (!domNode.attributes['data-placeholder']) {
          const slot = document.createElement('slot');
          const nodeId = tplNode.getAttribute('data-id');
          slot.setAttribute('data-id', nodeId);
          slot.setAttribute('data-placeholder', 1);
          slot.setAttribute('data-lastif', isTrue);
          domNode.replaceWith(slot);
          isChanged = true;
        } else {
          domNode.setAttribute('data-lastif', isTrue);
          isChanged = true;
        }
      } else {
        // Если в данный момент в доме слот, он заменяется нужной нодой.
        if (domNode.attributes['data-placeholder']) {
          const newNode = tplNode.cloneNode(true);
          newNode.setAttribute('data-lastif', isTrue);
          domNode.replaceWith(newNode);
          if (tplNode.nodeName.startsWith('C-')) {
            this.processNodes(tplNode, domParent);
          } else {
            this.processChildren(tplNode, domParent);
          }
          isChanged = true;
        } else {
          domNode.setAttribute('data-lastif', isTrue);
          // Здесь не нужно делать isChanged true, иначе не срабатывает @click.
          // isChanged = true;
        }
      }
    } else if (tplNode.attributes['@else']) {
      const domNode = nodesById(domParent, nodeId(tplNode))[0];
      const ifNode = domNode.previousElementSibling;
      if (ifNode.getAttribute('data-lastif') == 'true') {
        // Нода заменяется слотом только если ещё не заменена.
        if (!domNode.attributes['data-placeholder']) {
          const slot = document.createElement('slot');
          const nodeId = tplNode.getAttribute('data-id');
          slot.setAttribute('data-id', nodeId);
          slot.setAttribute('data-placeholder', 1);
          domNode.replaceWith(slot);
          isChanged = true;
        }
        isChanged = true;
      } else {
        // Если в данный момент в доме слот, он заменяется нужной нодой.
        if (domNode.attributes['data-placeholder']) {
          const newNode = tplNode.cloneNode(true);
          domNode.replaceWith(newNode);
          this.processChildren(tplNode, domParent);
          isChanged = true;
        }
        // Здесь не нужно делать isChanged true, иначе не срабатывает @click.
        // isChanged = true;
      }
    }
    return isChanged;
  }

  processLoop(tplNode, domParent) {
    if (tplNode.attributes['@for']) {
      const val = tplNode.attributes['@for'].value;
      const [itemName, _, srcName] = val.split(' ');
      let src = resolve(srcName, this.c);
      if (typeof(src) == 'function') src = src();
      let prevEl;
      for (let index = 0; index < src.length; index++) {
        this.context[itemName] = src[index];
        let domEl = nodesById(domParent, nodeId(tplNode))[index];
        // Если нода является заглушкой, значит в предыдущем рендере массив был пустым.
        // Тогда заглушку нужно заменить полноценной нодой.
        if (domEl?.attributes['data-placeholder']) {
          const newNode = tplNode.cloneNode(true);
          domEl.replaceWith(newNode);
          domEl = newNode;
        }
        if (!prevEl) {
          prevEl = domEl;
        }
        if (!domEl) {
          domEl = tplNode.cloneNode(true);
          domParent.insertBefore(domEl, prevEl?.nextSibling);
          prevEl = domEl;
        } else {
          prevEl = domEl;
        }
        this.processChildren(tplNode, domEl);
      }
      // Удаление лишних нод.
      const domEls = nodesById(domParent, nodeId(tplNode));
      let domElsCnt = domEls.length;
      while (domElsCnt > src.length) {
        if (domElsCnt > 1) {
          domParent.removeChild(domEls[domElsCnt-1]);
        } else {
          // Если обрабатывается пустой массив, всё удалять не нужно. Иначе, когда
          // в массив добавятся элементы, добавление в DOM произойдёт в неправильном месте.
          // Поэтому нужно сохранять одну ноду-заглушку.
          let domEl = nodesById(domParent, nodeId(tplNode))[0];
          const slot = document.createElement('slot');
          const nodeId = tplNode.getAttribute('data-id');
          slot.setAttribute('data-id', nodeId);
          slot.setAttribute('data-placeholder', 1);
          domEl.replaceWith(slot);
        }
        domElsCnt--;
      }
    }
  }

  processAttrs(tplNode, domParent) {
    const domNode = nodesById(domParent, nodeId(tplNode))[0];
    const dynamicAttrs = Array.from(tplNode.attributes)
      .filter(attr => attr.name.startsWith(':'))
      .forEach(dynAttr => {
        const attrName = dynAttr.name.split(':')[1];
        const valExpr = dynAttr.value;
        const res = this.interpolate(valExpr);
        if (attrName == 'value') {
          if (domNode.__value != res) {
            domNode.value = res;
            domNode.__value = res;
          }
        } else if (attrName == 'text') {
          if (domNode.__value != res) {
            domNode.textContent = res;
            domNode.__value = res;
          }
        } else if (['checked', 'disabled'].includes(attrName) && ['INPUT', 'BUTTON'].includes(tplNode.nodeName)) {
          const isTrue = fixExprResult(res);
          domNode[attrName] = isTrue;
        } else {
          domNode.setAttribute(attrName, res);
        }
      });
  }

  processEvents(tplNode, domParent) {
    ['click', 'dblclick', 'change', 'input', 'enter'].forEach(evName => {
      if (tplNode.attributes[`@${evName}`]) {
        let methodnameTpl = tplNode.attributes[`@${evName}`].value;
        const domNode = nodesById(domParent, nodeId(tplNode))[0];
        let methodname = methodnameTpl;
        let arg;
        if (methodnameTpl.includes('(')) {
          arg = methodnameTpl.split('(')[1].split(')')[0];
          methodname = methodnameTpl.split('(')[0];
          arg = this.context[arg];
        }
        if (evName == 'enter') {
          domNode.removeEventListener('keypress', domNode.__mylistener);
          const wrapper = (arg) => (ev) => {
            if (ev.key == 'Enter') {
              this.c[methodname](ev,arg)
            }
          };
          domNode.__mylistener = wrapper(arg);
          domNode.addEventListener('keypress', domNode.__mylistener);
        } else {
          const wrapper = (arg) => (ev) => {
            if (typeof this.c[methodname] != 'function') {
              console.warn('No method', methodname, 'in', this.c);
            }
            this.c[methodname](ev,arg)
          };
          domNode.removeEventListener(evName, domNode.__mylistener);
          domNode.__mylistener = wrapper(arg);
          domNode.addEventListener(evName, domNode.__mylistener);
        }
      }
    });
  }

  processComponentProps(cmp, tplNode, domParent) {
    if (!cmp.propsList) return;
    cmp.props = {};
    const propsList = cmp.propsList.map(p => p.toLowerCase());
    const domNode = nodesById(domParent, nodeId(tplNode))[0];
    const dynamicAttrs = Array.from(tplNode.attributes)
      .filter(attr => attr.name.startsWith(':'))
      .forEach(dynAttr => {
        const attrName = dynAttr.name.split(':')[1];
        const valName = dynAttr.value;
        if (cmp.propsList?.includes(attrName)) {

          if (this.context[valName]) {
            cmp.props[attrName] = this.context[valName];
          } else {
            const r = resolve(valName, this.c);
            if (r) {
              cmp.props[attrName] = resolve(valName, this.c);
            } else {
              cmp.props[attrName] = valName;
            }
          }
        }
      })
  }

  interpolate(tpl) {
    const ctx = this.context;
    const state = {state: this.c.state};
    const props = {props: this.props};

    const func = new Function(
      ...Object.keys(ctx),
      ...Object.keys(state),
      ...Object.keys(props),
      ...instanceMethodNames(this.c),
      "return `"+tpl+"`;")
    return func(
      ...Object.values(ctx),
      ...Object.values(state),
      ...Object.values(props),
      ...instanceMethodsAsArray(this.c),
    );
  }
}


function instanceMethodNames(instance) {
  const arrows = Object.getOwnPropertyNames(instance);
  const normal = Object.getOwnPropertyNames(instance.constructor.prototype);
  return arrows.concat(normal).filter(name => name != 'constructor');
}


function instanceMethodsAsArray(instance) {
  const names = instanceMethodNames(instance);
  return names.filter(name => name != 'constructor')
    .map(name => instance[name])
}


window.__CUR_OBSERVERS = [];
export function observer(fn, name, isDeleted) {
  let timeout;
  const c = {
    name: name,
    isDeleted: isDeleted,
    execute() {
      if (__CUR_OBSERVERS.indexOf(c) == -1) {
        __CUR_OBSERVERS.push(c);
      }
      window.cancelAnimationFrame(timeout);
      timeout = window.requestAnimationFrame(() => {
        fn();
        const idx = __CUR_OBSERVERS.indexOf(c);
        __CUR_OBSERVERS.splice(idx, 1);
      });
    }
  }
  c.execute()
};


export function reactive(v) {
  if (['number', 'string', 'boolean'].includes(typeof(v))) {
    return new Proxy({val: v}, makeHandler());
  }
  return new Proxy(v, makeHandler());
};
export const r = reactive;


const makeHandler = () => {
  const subs = new Set();
  const handler = {
    get(target, key, receiver) {
      if (key == '__isProxy') return true;
      const prop = target[key];
      if (typeof prop == 'undefined') return;

      if (typeof prop == 'object' && prop != null && !prop.__isProxy) {
        target[key] = new Proxy(prop, makeHandler());
        target[key].__isProxy = true;
      }

      if (__CUR_OBSERVERS.length > 0) {
        __CUR_OBSERVERS.forEach(obs => {
          subs.add(obs);
        });
        for (const observer of subs) {
          if (observer.isDeleted && observer.isDeleted()) {
            subs.delete(observer);
          }
        }
      }
      return Reflect.get(...arguments)
    },
    set(target, key, value, receiver) {
      if (target[key] === value) return true;
      target[key] = value;
      for (const observer of subs) {
        if (observer.isDeleted && observer.isDeleted()) {
          subs.delete(observer);
        }  else {
          observer.execute();
        }
      }
      return true;
    },
    subs: subs
  };
  return handler;
};


export function resolve(path, obj) {
  if (obj === undefined) obj = this;
  return path.split('.').reduce((p,c)=>p&&p[c], obj)
}


function fixExprResult(v) {
  if (v == 'false') return false;
  else if (v == 'true') return true;
  return v;
}


export function emit(node, name, detail) {
  const ev = new CustomEvent(name, {bubbles: true, detail: detail});
  node.dispatchEvent(ev);
}


export function nodeId(node) {
  return node.getAttribute('data-id');
}


export function nodesById(parent, nodeId) {
  return parent.querySelectorAll(`[data-id="${nodeId}"]`);
}
