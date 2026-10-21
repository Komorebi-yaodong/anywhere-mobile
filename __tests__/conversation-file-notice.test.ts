import {conversationFiles, editableConversationText, withoutConversationFiles} from '../src/components/conversationFileNotice';

const doc = 'file name:fixture.docx\nfile content:\nORIGINAL_DOCX\nfile end';
const sheet = 'file name:fixture.xlsx\nfile content:\nORIGINAL_XLSX\nfile end';
it('separates file cards from editable prose for old and new Desktop DTOs', () => {
  const content = [{type: 'text', text: 'user input'}, {type: 'text', text: doc}, {type: 'text', text: sheet}, {type: 'image', url: 'anywhere-media://image_fixture_0001?type=image'}];
  expect(conversationFiles(content)).toEqual([{name: 'fixture.docx'}, {name: 'fixture.xlsx'}]);
  expect(editableConversationText(content)).toBe('user input');
  expect(withoutConversationFiles(content)).toEqual([content[0], content[3]]);
  expect(conversationFiles([{type: 'file', name: 'fixture.docx', previewable: false}])).toEqual([{name: 'fixture.docx'}]);
  expect(editableConversationText(doc)).toBe('');
  expect(editableConversationText('`E:\\Synthetic\\fixture.docx`\nmy text')).toBe('`E:\\Synthetic\\fixture.docx`\nmy text');
});
