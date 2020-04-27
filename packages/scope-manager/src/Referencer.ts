import {
  TSESTree,
  AST_NODE_TYPES,
} from '@typescript-eslint/experimental-utils';
import assert from 'assert';
import { Visitor, VisitorOptions } from 'esrecurse';
import { Definition, ParameterDefinition } from './Definition';
import {
  PatternVisitor,
  PatternVisitorCallback,
  PatternVisitorOptions,
} from './PatternVisitor';
import { ReferenceFlag, ReferenceImplicitGlobal } from './Reference';
import { Scope } from './scope';
import { ScopeManager } from './ScopeManager';
import { VariableType } from './VariableType';
import { FunctionScope } from './scope/FunctionScope';

/**
 * Traverse identifier in pattern
 */
function traverseIdentifierInPattern(
  options: PatternVisitorOptions,
  rootPattern: TSESTree.Node,
  referencer: Referencer | null | undefined,
  callback: PatternVisitorCallback,
): void {
  // Call the callback at left hand identifier nodes, and Collect right hand nodes.
  const visitor = new PatternVisitor(options, rootPattern, callback);

  visitor.visit(rootPattern);

  // Process the right hand nodes recursively.
  if (referencer != null) {
    visitor.rightHandNodes.forEach(referencer.visit, referencer);
  }
}

// Importing ImportDeclaration.
// http://people.mozilla.org/~jorendorff/es6-draft.html#sec-moduledeclarationinstantiation
// https://github.com/estree/estree/blob/master/es6.md#importdeclaration
// FIXME: Now, we don't create module environment, because the context is
// implementation dependent.

class Importer extends Visitor {
  public readonly declaration: TSESTree.ImportDeclaration;
  public readonly referencer: Referencer;

  constructor(declaration: TSESTree.ImportDeclaration, referencer: Referencer) {
    super(null, referencer.options);
    this.declaration = declaration;
    this.referencer = referencer;
  }

  visitImport(
    id: TSESTree.Identifier,
    specifier:
      | TSESTree.ImportDefaultSpecifier
      | TSESTree.ImportNamespaceSpecifier
      | TSESTree.ImportSpecifier,
  ): void {
    this.referencer.visitPattern(id, pattern => {
      this.referencer
        .currentScope(true)
        .__define(
          pattern,
          new Definition(
            VariableType.ImportBinding,
            pattern,
            specifier,
            this.declaration,
            null,
            null,
          ),
        );
    });
  }

  ImportNamespaceSpecifier(node: TSESTree.ImportNamespaceSpecifier): void {
    const local = node.local;
    this.visitImport(local, node);
  }

  ImportDefaultSpecifier(node: TSESTree.ImportDefaultSpecifier): void {
    const local = node.local;
    this.visitImport(local, node);
  }

  ImportSpecifier(node: TSESTree.ImportSpecifier): void {
    const local = node.local;
    this.visitImport(local, node);
  }
}

type ReferencerOptions = VisitorOptions;
// Referencing variables and creating bindings.
class Referencer extends Visitor {
  isInnerMethodDefinition: boolean;
  options: ReferencerOptions;
  scopeManager: ScopeManager;
  parent: TSESTree.Node | null;

  constructor(options: ReferencerOptions, scopeManager: ScopeManager) {
    super(null, options);
    this.options = options;
    this.scopeManager = scopeManager;
    this.parent = null;
    this.isInnerMethodDefinition = false;
  }

  currentScope(): Scope | null;
  currentScope(throwOnNull: true): Scope;
  currentScope(throwOnNull?: boolean): Scope | null {
    if (throwOnNull) {
      assert(this.scopeManager.__currentScope);
    }
    return this.scopeManager.__currentScope;
  }

  close(node: TSESTree.Node): void {
    while (this.currentScope() && node === this.currentScope()!.block) {
      this.scopeManager.__currentScope = this.currentScope()!.__close(
        this.scopeManager,
      );
    }
  }

  pushInnerMethodDefinition(isInnerMethodDefinition: boolean): boolean {
    const previous = this.isInnerMethodDefinition;

    this.isInnerMethodDefinition = isInnerMethodDefinition;
    return previous;
  }

  popInnerMethodDefinition(isInnerMethodDefinition: boolean | undefined): void {
    this.isInnerMethodDefinition = !!isInnerMethodDefinition;
  }

  referencingDefaultValue(
    pattern: TSESTree.Node,
    assignments: (TSESTree.AssignmentExpression | TSESTree.AssignmentPattern)[],
    maybeImplicitGlobal: ReferenceImplicitGlobal | null,
    init: boolean,
  ): void {
    assignments.forEach(assignment => {
      this.currentScope(true).__referencing(
        pattern,
        ReferenceFlag.WRITE,
        assignment.right,
        maybeImplicitGlobal,
        pattern !== assignment.left,
        init,
      );
    });
  }

  visitPattern(node: TSESTree.Node, callback: PatternVisitorCallback): void;
  visitPattern(
    node: TSESTree.Node,
    options: PatternVisitorOptions,
    callback: PatternVisitorCallback,
  ): void;
  visitPattern(
    node: TSESTree.Node,
    optionsOrCallback: PatternVisitorCallback | PatternVisitorOptions,
    callback?: PatternVisitorCallback,
  ): void {
    let visitPatternOptions: PatternVisitorOptions;
    let visitPatternCallback: PatternVisitorCallback;

    if (typeof optionsOrCallback === 'function') {
      visitPatternCallback = optionsOrCallback;
      visitPatternOptions = { processRightHandNodes: false };
    } else {
      assert(callback);
      visitPatternCallback = callback!;
      visitPatternOptions = optionsOrCallback;
    }

    traverseIdentifierInPattern(
      this.options,
      node,
      visitPatternOptions.processRightHandNodes ? this : null,
      visitPatternCallback,
    );
  }

  visitFunction(node: Exclude<FunctionScope['block'], TSESTree.Program>): void {
    let i: number, iz: number;

    // FunctionDeclaration name is defined in upper scope
    // NOTE: Not referring variableScope. It is intended.
    // Since
    //  in ES5, FunctionDeclaration should be in FunctionBody.
    //  in ES6, FunctionDeclaration should be block scoped.

    if (node.type === AST_NODE_TYPES.FunctionDeclaration && node.id) {
      // id is defined in upper scope
      this.currentScope(true).__define(
        node.id,
        new Definition(
          VariableType.FunctionName,
          node.id,
          node,
          null,
          null,
          null,
        ),
      );
    }

    // FunctionExpression with name creates its special scope;
    // FunctionExpressionNameScope.
    if (node.type === AST_NODE_TYPES.FunctionExpression && node.id) {
      this.scopeManager.__nestFunctionExpressionNameScope(node);
    }

    // Consider this function is in the MethodDefinition.
    this.scopeManager.__nestFunctionScope(node, this.isInnerMethodDefinition);

    const visitPatternCallback: PatternVisitorCallback = (pattern, info) => {
      this.currentScope(true).__define(
        pattern,
        new ParameterDefinition(pattern, node, i, info.rest),
      );

      this.referencingDefaultValue(pattern, info.assignments, null, true);
    };

    // Process parameter declarations.
    for (i = 0, iz = node.params.length; i < iz; ++i) {
      this.visitPattern(
        node.params[i],
        { processRightHandNodes: true },
        visitPatternCallback,
      );
    }

    // In TypeScript there are a number of function-like constructs which have no body,
    // so check it exists before traversing
    if (node.body) {
      // Skip BlockStatement to prevent creating BlockStatement scope.
      if (node.body.type === AST_NODE_TYPES.BlockStatement) {
        this.visitChildren(node.body);
      } else {
        this.visit(node.body);
      }
    }

    this.close(node);
  }

  visitClass(node: TSESTree.ClassDeclaration | TSESTree.ClassExpression): void {
    if (node.type === AST_NODE_TYPES.ClassDeclaration && node.id) {
      this.currentScope(true).__define(
        node.id,
        new Definition(VariableType.ClassName, node.id, node, null, null, null),
      );
    }

    this.visit(node.superClass);

    this.scopeManager.__nestClassScope(node);

    if (node.id) {
      this.currentScope(true).__define(
        node.id,
        new Definition(VariableType.ClassName, node.id, node),
      );
    }
    this.visit(node.body);

    this.close(node);
  }

  visitProperty(
    node:
      | TSESTree.MethodDefinition
      | TSESTree.TSAbstractMethodDefinition
      | TSESTree.Property,
  ): void {
    let previous;

    if (node.computed) {
      this.visit(node.key);
    }

    const isMethodDefinition = node.type === AST_NODE_TYPES.MethodDefinition;

    if (isMethodDefinition) {
      previous = this.pushInnerMethodDefinition(true);
    }
    this.visit(node.value);
    if (isMethodDefinition) {
      this.popInnerMethodDefinition(previous);
    }
  }

  visitForIn(node: TSESTree.ForInStatement | TSESTree.ForOfStatement): void {
    if (
      node.left.type === AST_NODE_TYPES.VariableDeclaration &&
      node.left.kind !== 'var'
    ) {
      this.scopeManager.__nestForScope(node);
    }

    if (node.left.type === AST_NODE_TYPES.VariableDeclaration) {
      this.visit(node.left);
      this.visitPattern(node.left.declarations[0].id, pattern => {
        this.currentScope(true).__referencing(
          pattern,
          ReferenceFlag.WRITE,
          node.right,
          null,
          true,
          true,
        );
      });
    } else {
      this.visitPattern(
        node.left,
        { processRightHandNodes: true },
        (pattern, info) => {
          let maybeImplicitGlobal = null;

          if (!this.currentScope(true).isStrict) {
            maybeImplicitGlobal = {
              pattern,
              node,
            };
          }
          this.referencingDefaultValue(
            pattern,
            info.assignments,
            maybeImplicitGlobal,
            false,
          );
          this.currentScope(true).__referencing(
            pattern,
            ReferenceFlag.WRITE,
            node.right,
            maybeImplicitGlobal,
            true,
            false,
          );
        },
      );
    }
    this.visit(node.right);
    this.visit(node.body);

    this.close(node);
  }

  visitVariableDeclaration(
    variableTargetScope: Scope,
    type: VariableType.Variable,
    node: TSESTree.VariableDeclaration,
    index: number,
  ): void {
    const decl = node.declarations[index];
    const init = decl.init;

    this.visitPattern(
      decl.id,
      { processRightHandNodes: true },
      (pattern, info) => {
        variableTargetScope.__define(
          pattern,
          new Definition(type, pattern, decl, node, index, node.kind),
        );

        this.referencingDefaultValue(pattern, info.assignments, null, true);
        if (init) {
          this.currentScope(true).__referencing(
            pattern,
            ReferenceFlag.WRITE,
            init,
            null,
            !info.topLevel,
            true,
          );
        }
      },
    );
  }

  AssignmentExpression(node: TSESTree.AssignmentExpression): void {
    if (PatternVisitor.isPattern(node.left)) {
      if (node.operator === '=') {
        this.visitPattern(
          node.left,
          { processRightHandNodes: true },
          (pattern, info) => {
            let maybeImplicitGlobal = null;

            if (!this.currentScope(true).isStrict) {
              maybeImplicitGlobal = {
                pattern,
                node,
              };
            }
            this.referencingDefaultValue(
              pattern,
              info.assignments,
              maybeImplicitGlobal,
              false,
            );
            this.currentScope(true).__referencing(
              pattern,
              ReferenceFlag.WRITE,
              node.right,
              maybeImplicitGlobal,
              !info.topLevel,
              false,
            );
          },
        );
      } else {
        this.currentScope(true).__referencing(
          node.left,
          ReferenceFlag.RW,
          node.right,
        );
      }
    } else {
      this.visit(node.left);
    }
    this.visit(node.right);
  }

  CatchClause(node: TSESTree.CatchClause): void {
    this.scopeManager.__nestCatchScope(node);

    if (node.param) {
      const param = node.param;
      this.visitPattern(
        param,
        { processRightHandNodes: true },
        (pattern, info) => {
          this.currentScope(true).__define(
            pattern,
            new Definition(
              VariableType.CatchClause,
              param,
              node,
              null,
              null,
              null,
            ),
          );
          this.referencingDefaultValue(pattern, info.assignments, null, true);
        },
      );
    }
    this.visit(node.body);

    this.close(node);
  }

  Program(node: TSESTree.Program): void {
    this.scopeManager.__nestGlobalScope(node);

    if (this.scopeManager.__isNodejsScope()) {
      // Force strictness of GlobalScope to false when using node.js scope.
      this.currentScope(true).isStrict = false;
      this.scopeManager.__nestFunctionScope(node, false);
    }

    if (this.scopeManager.__isES6() && this.scopeManager.isModule()) {
      this.scopeManager.__nestModuleScope(node);
    }

    if (
      this.scopeManager.isStrictModeSupported() &&
      this.scopeManager.isImpliedStrict()
    ) {
      this.currentScope(true).isStrict = true;
    }

    this.visitChildren(node);
    this.close(node);
  }

  Identifier(node: TSESTree.Identifier): void {
    this.currentScope(true).__referencing(node);
  }

  UpdateExpression(node: TSESTree.UpdateExpression): void {
    if (PatternVisitor.isPattern(node.argument)) {
      this.currentScope(true).__referencing(
        node.argument,
        ReferenceFlag.RW,
        null,
      );
    } else {
      this.visitChildren(node);
    }
  }

  MemberExpression(node: TSESTree.MemberExpression): void {
    this.visit(node.object);
    if (node.computed) {
      this.visit(node.property);
    }
  }

  Property(node: TSESTree.Property): void {
    this.visitProperty(node);
  }

  MethodDefinition(node: TSESTree.MethodDefinition): void {
    this.visitProperty(node);
  }

  BreakStatement(): void {} // eslint-disable-line @typescript-eslint/no-empty-function

  ContinueStatement(): void {} // eslint-disable-line @typescript-eslint/no-empty-function

  LabeledStatement(node: TSESTree.LabeledStatement): void {
    this.visit(node.body);
  }

  ForStatement(node: TSESTree.ForStatement): void {
    // Create ForStatement declaration.
    // NOTE: In ES6, ForStatement dynamically generates
    // per iteration environment. However, escope is
    // a static analyzer, we only generate one scope for ForStatement.
    if (
      node.init &&
      node.init.type === AST_NODE_TYPES.VariableDeclaration &&
      node.init.kind !== 'var'
    ) {
      this.scopeManager.__nestForScope(node);
    }

    this.visitChildren(node);

    this.close(node);
  }

  ClassExpression(node: TSESTree.ClassExpression): void {
    this.visitClass(node);
  }

  ClassDeclaration(node: TSESTree.ClassDeclaration): void {
    this.visitClass(node);
  }

  CallExpression(node: TSESTree.CallExpression): void {
    // Check this is direct call to eval
    if (
      !this.scopeManager.__ignoreEval() &&
      node.callee.type === AST_NODE_TYPES.Identifier &&
      node.callee.name === 'eval'
    ) {
      // NOTE: This should be `variableScope`. Since direct eval call always creates Lexical environment and
      // let / const should be enclosed into it. Only VariableDeclaration affects on the caller's environment.
      this.currentScope(true).variableScope.__detectEval();
    }
    this.visitChildren(node);
  }

  BlockStatement(node: TSESTree.BlockStatement): void {
    if (this.scopeManager.__isES6()) {
      this.scopeManager.__nestBlockScope(node);
    }

    this.visitChildren(node);

    this.close(node);
  }

  ThisExpression(): void {
    this.currentScope(true).variableScope.__detectThis();
  }

  WithStatement(node: TSESTree.WithStatement): void {
    this.visit(node.object);

    // Then nest scope for WithStatement.
    this.scopeManager.__nestWithScope(node);

    this.visit(node.body);

    this.close(node);
  }

  VariableDeclaration(node: TSESTree.VariableDeclaration): void {
    const variableTargetScope =
      node.kind === 'var'
        ? this.currentScope(true).variableScope
        : this.currentScope(true);

    for (let i = 0, iz = node.declarations.length; i < iz; ++i) {
      const decl = node.declarations[i];

      this.visitVariableDeclaration(
        variableTargetScope,
        VariableType.Variable,
        node,
        i,
      );
      if (decl.init) {
        this.visit(decl.init);
      }
    }
  }

  // sec 13.11.8
  SwitchStatement(node: TSESTree.SwitchStatement): void {
    this.visit(node.discriminant);

    if (this.scopeManager.__isES6()) {
      this.scopeManager.__nestSwitchScope(node);
    }

    for (let i = 0, iz = node.cases.length; i < iz; ++i) {
      this.visit(node.cases[i]);
    }

    this.close(node);
  }

  FunctionDeclaration(node: TSESTree.FunctionDeclaration): void {
    this.visitFunction(node);
  }

  FunctionExpression(node: TSESTree.FunctionExpression): void {
    this.visitFunction(node);
  }

  ForOfStatement(node: TSESTree.ForOfStatement): void {
    this.visitForIn(node);
  }

  ForInStatement(node: TSESTree.ForInStatement): void {
    this.visitForIn(node);
  }

  ArrowFunctionExpression(node: TSESTree.ArrowFunctionExpression): void {
    this.visitFunction(node);
  }

  ImportDeclaration(node: TSESTree.ImportDeclaration): void {
    assert(
      this.scopeManager.__isES6() && this.scopeManager.isModule(),
      'ImportDeclaration should appear when the mode is ES6 and in the module context.',
    );

    const importer = new Importer(node, this);

    importer.visit(node);
  }

  visitExportDeclaration(
    node: TSESTree.ExportDeclaration | TSESTree.ExportNamedDeclaration,
  ): void {
    if ('source' in node && node.source) {
      return;
    }
    if ('declaration' in node && node.declaration) {
      this.visit(node.declaration);
      return;
    }

    this.visitChildren(node);
  }

  ExportDeclaration(node: TSESTree.ExportDeclaration): void {
    this.visitExportDeclaration(node);
  }

  ExportNamedDeclaration(node: TSESTree.ExportNamedDeclaration): void {
    this.visitExportDeclaration(node);
  }

  ExportSpecifier(node: TSESTree.ExportSpecifier): void {
    const local = node.local;

    this.visit(local);
  }

  MetaProperty(): void {
    // do nothing.
  }
}

export { Referencer };
