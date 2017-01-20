/* @flow */

import * as t from 'babel-types';

import getTypeParameters from './getTypeParameters';
import typeAnnotationIterator from './typeAnnotationIterator';

import type {Node, NodePath} from 'babel-traverse';

import type ConversionContext from './ConversionContext';

export type Converter = (context: ConversionContext, path: NodePath) => Node;
export type ConverterDict = {[name: string]: Converter};

const converters: ConverterDict = {};

/**
 * Convert a type definition to a typed method call.
 */
function convert (context: ConversionContext, path: NodePath): Node {
  const loc = path.node.loc;
  let converter = converters[path.type];
  if (!converter) {
    if (path.isClass()) {
      converter = converters.Class;
    }
    else if (path.isFunction()) {
      converter = converters.Function;
    }
    else {
      console.warn(`Unsupported node type: ${path.type}, please report this issue at http://github.com/codemix/flow-runtime/issues`);
      const fallback = context.call('any');
      fallback.loc = loc;
      return fallback;
    }
  }
  const result = converter(context, path);
  if (result && loc) {
    result.loc = loc;
  }
  return result;
}

function annotationReferencesId (annotation: NodePath, name: string): boolean {
  for (const item of typeAnnotationIterator(annotation)) {
    if (item.type === 'Identifier' && item.node.name === name) {
      return true;
    }
  }
  return false;
}

/**
 * Determine whether a given type parameter exists in a position where
 * values it receives should flow into the union of types the annotation
 * allows. For example, given a function like `<T> (a: T, b: T) => T`,
 * T should be a union of whatever `a` and `b` are.
 *
 * If the annotation exists in a function parameter, it is considered flowable.
 */
function typeParameterCanFlow (annotation: NodePath) {
  let subject = annotation.parentPath;
  while (subject) {
    if (subject.isClassProperty()) {
      return true;
    }
    else if (subject.isFlow()) {
      subject = subject.parentPath;
      continue;
    }
    else if (subject.isStatement()) {
      return false;
    }

    if (subject.isIdentifier() || subject.isArrayPattern() || subject.isObjectPattern()) {
      if (subject.parentPath.isFunction() && subject.listKey === 'params') {
        return true;
      }
    }
    subject = subject.parentPath;
  }

  return false;
}

function annotationParentHasTypeParameter (annotation: NodePath, name: string): boolean {
  let subject = annotation.parentPath;
  while (subject && subject.isFlow()) {
    const typeParameters = getTypeParameters(subject);
    for (const typeParameter of typeParameters) {
      if (typeParameter.node.name === name) {
        return true;
      }
    }
    subject = subject.parentPath;
  }
  return false;
}

function parentIsStaticMethod (subject: NodePath): boolean {
  const fn = subject.findParent(item => item.isClassMethod());
  if (!fn) {
    return false;
  }
  return fn.node.static;
}

function parentIsClassConstructorWithSuper (subject: NodePath): boolean {
  const fn = subject.findParent(item => item.isClassMethod() && item.node.kind === 'constructor');
  if (!fn) {
    return false;
  }
  const classDefinition = fn.parentPath.parentPath;
  if (classDefinition.has('superClass')) {
    return true;
  }
  else {
    return parentIsClassConstructorWithSuper(classDefinition.parentPath);
  }
}

function qualifiedToMemberExpression (subject: Node): Node {
  if (subject.type === 'QualifiedTypeIdentifier') {
    return t.memberExpression(
      qualifiedToMemberExpression(subject.qualification),
      subject.id
    );
  }
  else {
    return subject;
  }
}

function annotationToValue (subject: Node): Node {
  switch (subject.type) {
    case 'NullableTypeAnnotation':
    case 'TypeAnnotation':
      return annotationToValue(subject.typeAnnotation);
    case 'GenericTypeAnnotation':
      return annotationToValue(subject.id);
    case 'QualifiedTypeIdentifier':
      return t.memberExpression(
        annotationToValue(subject.qualification),
        subject.id
      );
    case 'NullLiteralTypeAnnotation':
      return t.nullLiteral();
    case 'VoidTypeAnnotation':
      return t.identifier('undefined');
    case 'BooleanLiteralTypeAnnotation':
      return t.booleanLiteral(subject.value);
    case 'NumericLiteralTypeAnnotation':
      return t.numericLiteral(subject.value);
    case 'StringLiteralTypeAnnotation':
      return t.stringLiteral(subject.value);

    default:
      return subject;
  }
}

function getMemberExpressionObject (subject: Node): Node {
  if (subject.type === 'MemberExpression') {
    return getMemberExpressionObject(subject.object);
  }
  else {
    return subject;
  }
}

converters.DeclareVariable = (context: ConversionContext, path: NodePath): Node => {
  const id = path.get('id');
  if (id.has('typeAnnotation')) {
    return context.call(
      'declare',
      context.call(
        'var',
        t.stringLiteral(id.node.name),
        convert(context, id.get('typeAnnotation'))
      )
    );
  }
  else {
    return context.call('declare', context.call('var', t.stringLiteral(id.node.name)));
  }
};


converters.DeclareTypeAlias = (context: ConversionContext, path: NodePath): Node => {
  const id = path.get('id');
  const right = path.get('right');
  return context.call(
    'declare',
    context.call(
      'type',
      t.stringLiteral(id.node.name),
      convert(context, right)
    )
  );
};


converters.DeclareFunction = (context: ConversionContext, path: NodePath): Node => {
  const id = path.get('id');
  if (id.has('typeAnnotation')) {
    return context.call('declare', t.stringLiteral(id.node.name), convert(context, id.get('typeAnnotation')));
  }
  else {
    return context.call('declare', t.stringLiteral(id.node.name));
  }
};


converters.DeclareModule = (context: ConversionContext, path: NodePath): Node => {
  const id = path.get('id');
  const name = id.isStringLiteral() ? id.node.value : id.node.name;
  return context.call(
    'declare',
    context.call(
      'module',
      t.stringLiteral(name),
      t.arrowFunctionExpression(
        [t.identifier(context.libraryId)],
        t.blockStatement(path.get('body.body').map(item => t.expressionStatement(convert(context, item))))
      )
    )
  );
};


converters.DeclareModuleExports = (context: ConversionContext, path: NodePath): Node => {
  return context.call(
    'moduleExports',
    convert(context, path.get('typeAnnotation'))
  );
};

converters.InterfaceDeclaration = (context: ConversionContext, path: NodePath): Node => {
  const name = path.node.id.name;
  const typeParameters = getTypeParameters(path);
  let body = convert(context, path.get('body'));
  if (typeParameters.length > 0) {
    body = t.arrowFunctionExpression(
      [t.identifier(name)],
      t.blockStatement([
        t.variableDeclaration('const', typeParameters.map(typeParameter => t.variableDeclarator(
            t.identifier(typeParameter.node.name),
            t.callExpression(
              t.memberExpression(
                t.identifier(name),
                t.identifier('typeParameter')
              ),
              typeParameter.node.bound
                ? [t.stringLiteral(typeParameter.node.name), convert(context, typeParameter.get('bound'))]
                : [t.stringLiteral(typeParameter.node.name)]
            )
          )
        )),
        t.returnStatement(body)
      ])
    );
  }
  else if (annotationReferencesId(path.get('body'), name)) {
    // This type alias references itself, we need to wrap it in an arrow
    body = t.arrowFunctionExpression(
      [t.identifier(name)],
      t.blockStatement([
        t.returnStatement(body)
      ])
    );
  }

  if (path.has('extends')) {
    body = context.call(
      'intersect',
      ...path.get('extends').map(item => convert(context, item)),
      body
    );
  }

  return t.variableDeclaration('const', [
    t.variableDeclarator(
      t.identifier(name),
      context.call(
        'type',
        t.stringLiteral(name),
        body
      )
    )
  ]);
};

converters.InterfaceExtends = (context: ConversionContext, path: NodePath): Node => {
  const id = path.get('id');
  let method = 'extends';
  if (path.parentPath.isInterfaceDeclaration()) {
    method = 'ref';
  }
  let name;
  let subject;
  if (id.isQualifiedTypeIdentifier()) {
    subject = qualifiedToMemberExpression(id.node);
    const outer = getMemberExpressionObject(subject);
    name = outer.name;
  }
  else {
    name = id.node.name;
    subject = t.identifier(name);
  }
  const typeParameters = getTypeParameters(path).map(item => convert(context, item));
  const entity = context.getEntity(name, path);

  const isDirectlyReferenceable
        = annotationParentHasTypeParameter(path, name)
        || (entity && (entity.isTypeAlias || entity.isTypeParameter))
        ;

  if (isDirectlyReferenceable) {
    if (typeParameters.length > 0) {
      return context.call(method, subject, ...typeParameters);
    }
    else {
      return subject;
    }
  }
  else if (!entity) {
    return context.call(method, t.stringLiteral(name), ...typeParameters);
  }
  else {
    return context.call(method, subject, ...typeParameters);
  }
};

converters.DeclareClass = (context: ConversionContext, path: NodePath): Node => {
  const id = path.get('id');
  const name = id.node.name;

  const extra = [];

  if (path.has('extends')) {
    const interfaceExtends = path.get('extends').map(item => convert(context, item));
    extra.push(...interfaceExtends);
  }

  const typeParameters = getTypeParameters(path);
  if (typeParameters.length > 0) {
    const uid = path.scope.generateUidIdentifier(name);
    return context.call('declare', context.call('class', t.stringLiteral(name), t.arrowFunctionExpression(
      [uid],
      t.blockStatement([
        t.variableDeclaration('const', typeParameters.map(typeParameter => t.variableDeclarator(
            t.identifier(typeParameter.node.name),
            t.callExpression(
              t.memberExpression(
                uid,
                t.identifier('typeParameter')
              ),
              typeParameter.node.bound
                ? [t.stringLiteral(typeParameter.node.name), convert(context, typeParameter.get('bound'))]
                : [t.stringLiteral(typeParameter.node.name)]
            )
          )
        )),
        t.returnStatement(convert(context, path.get('body')))
      ])
    ), ...extra));
  }
  else {
    return context.call(
      'declare',
      context.call(
        'class',
        t.stringLiteral(name),
        convert(context, path.get('body')),
        ...extra
      )
    );
  }
};

converters.TypeAlias = (context: ConversionContext, path: NodePath): Node => {
  const name = path.node.id.name;
  const typeParameters = getTypeParameters(path);
  let body = convert(context, path.get('right'));
  if (typeParameters.length > 0) {
    body = t.arrowFunctionExpression(
      [t.identifier(name)],
      t.blockStatement([
        t.variableDeclaration('const', typeParameters.map(typeParameter => t.variableDeclarator(
            t.identifier(typeParameter.node.name),
            t.callExpression(
              t.memberExpression(
                t.identifier(name),
                t.identifier('typeParameter')
              ),
              typeParameter.node.bound
                ? [t.stringLiteral(typeParameter.node.name), convert(context, typeParameter.get('bound'))]
                : [t.stringLiteral(typeParameter.node.name)]
            )
          )
        )),
        t.returnStatement(body)
      ])
    );
  }
  else if (annotationReferencesId(path.get('right'), path.node.id.name)) {
    // This type alias references itself, we need to wrap it in an arrow
    body = t.arrowFunctionExpression(
      [t.identifier(name)],
      t.blockStatement([
        t.returnStatement(body)
      ])
    );
  }
  return t.variableDeclaration('const', [
    t.variableDeclarator(
      t.identifier(name),
      context.call(
        'type',
        t.stringLiteral(name),
        body
      )
    )
  ]);
};

converters.TypeofTypeAnnotation = (context: ConversionContext, path: NodePath): Node => {
  return context.call('typeOf', annotationToValue(path.get('argument').node));
};

converters.TypeParameter = (context: ConversionContext, path: NodePath): Node => {
  if (path.has('bound')) {
    return context.call('typeParameter', t.stringLiteral(path.node.name), convert(context, path.get('bound')));
  }
  else {
    return context.call('typeParameter', t.stringLiteral(path.node.name));
  }
};

converters.TypeAnnotation = (context: ConversionContext, path: NodePath): Node => {
  return convert(context, path.get('typeAnnotation'));
};

converters.NullableTypeAnnotation = (context: ConversionContext, path: NodePath): Node => {
  return context.call('nullable', convert(context, path.get('typeAnnotation')));
};

converters.NullLiteralTypeAnnotation = (context: ConversionContext, {node}: NodePath): Node => {
  return context.call('null');
};

converters.AnyTypeAnnotation = (context: ConversionContext, {node}: NodePath): Node => {
  return context.call('any');
};

converters.MixedTypeAnnotation = (context: ConversionContext, {node}: NodePath): Node => {
  return context.call('mixed');
};

converters.ExistentialTypeParam = (context: ConversionContext, {node}: NodePath): Node => {
  return context.call('existential');
};

converters.EmptyTypeAnnotation = (context: ConversionContext, {node}: NodePath): Node => {
  return context.call('empty');
};

converters.NumberTypeAnnotation = (context: ConversionContext, {node}: NodePath): Node => {
  return context.call('number');
};

converters.NumericLiteralTypeAnnotation = (context: ConversionContext, {node}: NodePath): Node => {
  return context.call('number', t.numericLiteral(node.value));
};

converters.BooleanTypeAnnotation = (context: ConversionContext, {node}: NodePath): Node => {
  return context.call('boolean');
};

converters.BooleanLiteralTypeAnnotation = (context: ConversionContext, {node}: NodePath): Node => {
  return context.call('boolean', t.booleanLiteral(node.value));
};

converters.StringTypeAnnotation = (context: ConversionContext, {node}: NodePath): Node => {
  return context.call('string');
};

converters.StringLiteralTypeAnnotation = (context: ConversionContext, {node}: NodePath): Node => {
  return context.call('string', t.stringLiteral(node.value));
};

converters.VoidTypeAnnotation = (context: ConversionContext, {node}: NodePath): Node => {
  return context.call('void');
};

converters.UnionTypeAnnotation = (context: ConversionContext, path: NodePath): Node => {
  const types = path.get('types').map(item => convert(context, item));
  return context.call('union', ...types);
};

converters.IntersectionTypeAnnotation = (context: ConversionContext, path: NodePath): Node => {
  const types = path.get('types').map(item => convert(context, item));
  return context.call('intersection', ...types);
};

converters.ThisTypeAnnotation = (context: ConversionContext, path: NodePath): Node => {
  return context.call('this');
};

converters.GenericTypeAnnotation = (context: ConversionContext, path: NodePath): Node => {
  const id = path.get('id');
  let name;
  let subject;
  if (id.isQualifiedTypeIdentifier()) {
    subject = qualifiedToMemberExpression(id.node);
    const outer = getMemberExpressionObject(subject);
    name = outer.name;
  }
  else {
    name = id.node.name;
    subject = t.identifier(name);
  }
  if (context.shouldSuppressTypeName(name)) {
    return context.call('any');
  }
  if (context.isBoxed(id.node)) {
    subject = context.call('box', t.arrowFunctionExpression([], subject));
  }
  const typeParameters = getTypeParameters(path).map(item => convert(context, item));
  const entity = context.getEntity(name, path);


  const isTypeParameter = (
    (entity && entity.isTypeParameter)
    || (context.isAnnotating && entity && entity.isClassTypeParameter)
    || annotationParentHasTypeParameter(path, name)
  );


  if (isTypeParameter && typeParameterCanFlow(path)) {
    subject = context.call('flowInto', subject);
  }

  const isDirectlyReferenceable
        = isTypeParameter
        || (entity && entity.isTypeAlias)
        ;


  if (isDirectlyReferenceable) {
    if (typeParameters.length > 0) {
      return context.call('ref', subject, ...typeParameters);
    }
    else {
      return subject;
    }
  }
  else if (!entity) {
    return context.call('ref', t.stringLiteral(name), ...typeParameters);
  }
  else if (entity.isClassTypeParameter) {
    let target;
    const typeParametersUid = context.getClassData(path, 'typeParametersUid');
    const typeParametersSymbolUid = context.getClassData(path, 'typeParametersSymbolUid');
    if (typeParametersUid && parentIsStaticMethod(path)) {
      target = t.memberExpression(
        t.identifier(typeParametersUid),
        subject
      );
    }
    else if (typeParametersUid && parentIsClassConstructorWithSuper(path)) {
      target = t.memberExpression(
        t.identifier(typeParametersUid),
        subject
      );
    }
    else if (typeParametersSymbolUid) {
      target = t.memberExpression(
        t.memberExpression(
          t.thisExpression(),
          t.identifier(typeParametersSymbolUid),
          true
        ),
        subject
      );
    }
    else {
      target = t.memberExpression(
        t.memberExpression(
          t.thisExpression(),
          t.memberExpression(
            t.thisExpression(),
            context.symbol('TypeParameters'),
            true
          ),
          true
        ),
        subject
      );
    }

    if (typeParameterCanFlow(path)) {
      target = context.call('flowInto', target);
    }

    if (typeParameters.length > 0) {
      return context.call('ref', target, ...typeParameters);
    }
    else {
      return target;
    }
  }
  else {
    if (name === 'Array') {
      return context.call('array', ...typeParameters);
    }
    return context.call('ref', subject, ...typeParameters);
  }
};

converters.ArrayTypeAnnotation = (context: ConversionContext, path: NodePath): Node => {
  const elementType = convert(context, path.get('elementType'));
  return context.call('array', elementType);
};

converters.TupleTypeAnnotation = (context: ConversionContext, path: NodePath): Node => {
  const types = path.get('types').map(item => convert(context, item));
  return context.call('tuple', ...types);
};


converters.ObjectTypeAnnotation = (context: ConversionContext, path: NodePath): Node => {
  const body = [
    ...path.get('callProperties'),
    ...path.get('properties'),
    ...path.get('indexers')
  ];
  return context.call(path.node.exact ? 'exactObject' : 'object', ...body.map(item => convert(context, item)));
};

converters.ObjectTypeCallProperty = (context: ConversionContext, path: NodePath): Node => {
  return context.call('callProperty', convert(context, path.get('value')));
};

converters.ObjectTypeProperty = (context: ConversionContext, path: NodePath): Node => {
  const propName = t.stringLiteral(path.node.key.name);
  const value = convert(context, path.get('value'));
  if (path.node.optional) {
    return context.call('property', propName, value, t.booleanLiteral(true));
  }
  else {
    return context.call('property', propName, value);
  }
};

converters.ObjectTypeIndexer = (context: ConversionContext, path: NodePath): Node => {
  return context.call(
    'indexer',
    t.stringLiteral(path.node.id.name),
    convert(context, path.get('key')),
    convert(context, path.get('value'))
  );
};


converters.FunctionTypeAnnotation = (context: ConversionContext, path: NodePath): Node => {
  const body = [
    ...path.get('params').map(item => convert(context, item))
  ];
  if (path.has('rest')) {
    body.push(convert(context, path.get('rest')));
  }
  if (path.has('returnType')) {
    body.push(context.call('return', convert(context, path.get('returnType'))));
  }
  const typeParameters = getTypeParameters(path);
  if (typeParameters.length > 0) {
    const name = path.scope.generateUid('fn');
    return context.call('function', t.arrowFunctionExpression(
      [t.identifier(name)],
      t.blockStatement([
        t.variableDeclaration('const', typeParameters.map(typeParameter => t.variableDeclarator(
            t.identifier(typeParameter.node.name),
            t.callExpression(
              t.memberExpression(
                t.identifier(name),
                t.identifier('typeParameter')
              ),
              typeParameter.node.bound
                ? [t.stringLiteral(typeParameter.node.name), convert(context, typeParameter.get('bound'))]
                : [t.stringLiteral(typeParameter.node.name)]
            )
          )
        )),
        t.returnStatement(t.arrayExpression(body))
      ])
    ));
  }
  else {
    return context.call('function', ...body);
  }
};


converters.FunctionTypeParam = (context: ConversionContext, path: NodePath): Node => {
  const {name: {name}, optional} = path.node;
  const args = [
    t.stringLiteral(name),
    convert(context, path.get('typeAnnotation'))
  ];
  if (optional) {
    args.push(t.booleanLiteral(true));
  }
  if (path.key === 'rest') {
    return context.call('rest', ...args);
  }
  else {
    return context.call('param', ...args);
  }
};


// ---- CONCRETE NODES ----
// Everything after here deals with converting "real" nodes instead of flow nodes.


converters.Function = (context: ConversionContext, path: NodePath): Node => {
  const params = path.get('params');

  const typeParameters = getTypeParameters(path);

  const shouldBox = typeParameters.length > 0;

  const invocations = [];

  for (let param of params) {
    const argumentIndex = +param.key;
    let argumentName;
    if (param.isAssignmentPattern()) {
      param = param.get('left');
    }

    if (param.isIdentifier()) {
      argumentName = param.node.name;
    }
    else if (param.isRestElement()) {
      argumentName = param.node.argument.name;
    }
    else {
      argumentName = `_arg${argumentIndex === 0 ? '' : argumentIndex}`;
    }

    if (!param.has('typeAnnotation')) {
      invocations.push(context.call(
        'param',
        t.stringLiteral(argumentName),
        context.call('any')
      ));
      continue;
    }

    const typeAnnotation = param.get('typeAnnotation');

    if (param.isIdentifier()) {
      invocations.push(context.call(
        'param',
        t.stringLiteral(param.node.name),
        convert(context, typeAnnotation)
      ));
    }
    else if (param.isRestElement()) {
      invocations.push(context.call(
        'rest',
        t.stringLiteral(param.node.argument.name),
        convert(context, typeAnnotation)
      ));
    }
    else {
      invocations.push(context.call(
        'param',
        t.stringLiteral(argumentName),
        convert(context, typeAnnotation)
      ));
    }
  }

  if (path.has('returnType')) {
    invocations.push(context.call(
      'return',
      convert(context, path.get('returnType'))
    ));
  }

  if (shouldBox) {
    const declarations = [];
    const fn = path.scope.generateUidIdentifier('fn');

    for (const typeParameter of typeParameters) {
      const {name} = typeParameter.node;

      const args = [t.stringLiteral(name)];
      if (typeParameter.has('bound') && typeParameter.has('default')) {
        args.push(
          convert(context, typeParameter.get('bound')),
          convert(context, typeParameter.get('default'))
        );
      }
      else if (typeParameter.has('bound')) {
        args.push(
          convert(context, typeParameter.get('bound'))
        );
      }
      else if (typeParameter.has('default')) {
        args.push(
          t.identifier('undefined'), // make sure we don't confuse bound with default
          convert(context, typeParameter.get('default'))
        );
      }

      declarations.push(
        t.variableDeclaration('const', [
          t.variableDeclarator(
            t.identifier(name),
            t.callExpression(
              t.memberExpression(fn, t.identifier('typeParameter')),
              args
            )
          )
        ])
      );
    }

    return context.call(
      'function',
      t.arrowFunctionExpression([fn], t.blockStatement([
        ...declarations,
        t.returnStatement(t.arrayExpression(invocations))
      ]))
    );
  }
  else {
    return context.call(
      'function',
      ...invocations
    );
  }
};


converters.Class = (context: ConversionContext, path: NodePath): Node => {

  const typeParameters = getTypeParameters(path);

  const name = path.has('id') ? path.node.id.name : 'AnonymousClass';

  let shouldBox = typeParameters.length > 0;

  const invocations = [];

  const superTypeParameters = path.has('superTypeParameters')
      ? path.get('superTypeParameters.params')
      : []
      ;

  const hasSuperTypeParameters = superTypeParameters.length > 0;
  if (path.has('superClass')) {
    if (hasSuperTypeParameters) {
      invocations.push(context.call(
        'extends',
        path.node.superClass,
        ...superTypeParameters.map(item => convert(context, item))
      ));
    }
    else {
      invocations.push(context.call(
        'extends',
        path.node.superClass
      ));
    }
  }

  const body = path.get('body');

  for (const child of body.get('body')) {
    invocations.push(convert(context, child));
    if (!shouldBox && annotationReferencesId(child, name)) {
      shouldBox = true;
    }
  }

  if (shouldBox) {
    const declarations = [];
    const classId = t.identifier(name);

    for (const typeParameter of typeParameters) {
      const {name} = typeParameter.node;

      const args = [t.stringLiteral(name)];
      if (typeParameter.has('bound') && typeParameter.has('default')) {
        args.push(
          convert(context, typeParameter.get('bound')),
          convert(context, typeParameter.get('default'))
        );
      }
      else if (typeParameter.has('bound')) {
        args.push(
          convert(context, typeParameter.get('bound'))
        );
      }
      else if (typeParameter.has('default')) {
        args.push(
          t.identifier('undefined'), // make sure we don't confuse bound with default
          convert(context, typeParameter.get('default'))
        );
      }

      declarations.push(
        t.variableDeclaration('const', [
          t.variableDeclarator(
            t.identifier(name),
            t.callExpression(
              t.memberExpression(classId, t.identifier('typeParameter')),
              args
            )
          )
        ])
      );
    }

    return context.call(
      'class',
      t.stringLiteral(name),
      t.arrowFunctionExpression([classId], t.blockStatement([
        ...declarations,
        t.returnStatement(t.arrayExpression(invocations))
      ]))
    );
  }
  else {
    return context.call(
      'class',
      t.stringLiteral(name),
      ...invocations
    );
  }
};

converters.ClassProperty = (context: ConversionContext, path: NodePath): Node => {
  const typeAnnotation = path.has('typeAnnotation')
                       ? convert(context, path.get('typeAnnotation'))
                       : context.call('any')
                       ;
  if (path.node.computed) {
    // make an object type indexer
    const keyType = context.call('union',
      context.call('number'),
      context.call('string'),
      context.call('symbol'),
    );
    return context.call('indexer', t.stringLiteral('key'), keyType, typeAnnotation);
  }
  else if (path.get('key').isIdentifier()) {
    return context.call(path.node.static ? 'staticProperty' : 'property', t.stringLiteral(path.node.key.name), typeAnnotation);
  }
  else {
    return context.call(path.node.static ? 'staticProperty' : 'property', t.stringLiteral(path.node.key.value), typeAnnotation);
  }
};

converters.ClassMethod = (context: ConversionContext, path: NodePath): Node => {
  const params = path.get('params').map(param => {
    if (param.isIdentifier()) {
      return context.call('param',
        t.stringLiteral(param.node.name),
        convert(context, param)
      );
    }
    else if (param.isAssignmentPattern() && param.get('left').isIdentifier()) {
      return context.call('param',
        t.stringLiteral(param.node.left.name),
        convert(context, param)
      );
    }
    else {
      return context.call('param',
        t.stringLiteral(`_arg${param.key}`),
        convert(context, param)
      );
    }
  });
  const args = [...params];
  if (path.has('returnType')) {
    args.push(context.call('return', convert(context, path.get('returnType'))));
  }
  if (path.node.computed) {
    // make an object type indexer.
    const keyType = context.call('union',
      context.call('number'),
      context.call('string'),
      context.call('symbol'),
    );
    return context.call('indexer', t.stringLiteral('key'), keyType, context.call('function', ...args));
  }
  else {
    return context.call(path.node.static ? 'staticMethod' : 'method', t.stringLiteral(path.node.key.name), ...args);
  }
};


converters.RestElement = (context: ConversionContext, path: NodePath): Node => {
  if (!path.has('typeAnnotation')) {
    return context.call('array', context.call('any'));
  }
  else {
    return convert(context, path.get('typeAnnotation'));
  }
};

converters.RestProperty = (context: ConversionContext, path: NodePath): Node => {
  return context.call('object');
};

converters.Identifier = (context: ConversionContext, path: NodePath): Node => {
  if (!path.has('typeAnnotation')) {
    return context.call('any');
  }
  else {
    return convert(context, path.get('typeAnnotation'));
  }
};

converters.ArrayPattern = (context: ConversionContext, path: NodePath): Node => {
  if (!path.has('typeAnnotation')) {
    return context.call('array', context.call('any'));
  }
  else {
    return convert(context, path.get('typeAnnotation'));
  }
};

converters.ObjectPattern = (context: ConversionContext, path: NodePath): Node => {
  if (!path.has('typeAnnotation')) {
    return context.call('ref', t.identifier('Object'));
  }
  else {
    return convert(context, path.get('typeAnnotation'));
  }
};

converters.AssignmentPattern = (context: ConversionContext, path: NodePath): Node => {
  return convert(context, path.get('left'));
};

export default convert;


